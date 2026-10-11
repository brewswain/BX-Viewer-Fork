/**
 * The one long-lived device connection, and the glue between it and whichever
 * player page is mounted.
 *
 * A module-level singleton rather than React context, for two reasons. This
 * repo has no provider tree at all (`app/layout.tsx` is a bare server
 * component), and — more importantly — a device connection must survive route
 * changes and React remounts. A socket that reconnects every time the user
 * navigates from a video back to the library would be worse than useless.
 *
 * `tick` is called from the engine's per-frame callback, so everything on that
 * path is allocation-free and O(1); state updates for React are pushed only
 * when something a human would notice actually changes.
 */

import { buildStrokePlan, DEFAULT_FIT, DEFAULT_LINEARIZE, type FitOptions } from './plan'
import { EMPTY_PLAN, StrokeDriver, type StrokePlan } from './driver'
import { BenchRecorder } from './bench'
import { FPS } from '@/lib/player/constants'
import { ButtplugBackend, DEFAULT_BUTTPLUG_URL } from './buttplug'
import { DEFAULT_XTOYS_URL, XToysBackend } from './xtoys'
import { DEFAULT_OSSM_URL, OssmDirectBackend } from './ossmDirect'
import type {
  BackendKind,
  ConnectionState,
  DeviceBackend,
  DeviceInfo,
} from './types'
import type { BxGovernor, Marker } from '@/lib/player/types'

const UNKNOWN_GOVERNOR: BxGovernor = { governorLevel: 'unknown', capsHash: 'unknown' }

export type DeviceConfig = {
  backend: BackendKind
  buttplugUrl: string
  xtoysUrl: string
  ossmUrl: string
  /** Master switch: when false nothing connects and nothing moves. */
  enabled: boolean
  /** Connect as soon as a player page mounts. */
  autoConnect: boolean
  rangeMin: number
  rangeMax: number
  invert: boolean
  /** Positive shifts device motion later than the picture. */
  offsetMs: number
  /**
   * Shortest command the plan may contain. Raising it thins out dense passages
   * for transports (or bridges) that cannot keep up.
   */
  minCmdMs: number
  /**
   * Drop the wiggles the machine cannot make in time (`fitToMachine`), judged
   * against the caps below, so fast passages keep full-length strokes.
   */
  fitEnabled: boolean
  /** Steps/s, the speed the Sauce app is set to. */
  fitMaxSpeed: number
  /** Steps/s², the accel the Sauce app is set to. */
  fitMaxAccel: number
  /** Steps the machine's homed range spans; the stroke range is applied on top. */
  fitTravelSteps: number
}

/** Config keys that change the plan rather than just the next command. */
const PLAN_KEYS = ['minCmdMs', 'fitEnabled', 'fitMaxSpeed', 'fitMaxAccel', 'fitTravelSteps'] as const

/** The fit the plan is built with, or undefined when fitting is off. */
export function fitFor(c: DeviceConfig): FitOptions | undefined {
  if (!c.fitEnabled) return undefined
  return {
    maxSpeed: c.fitMaxSpeed,
    maxAccel: c.fitMaxAccel,
    travelSteps: c.fitTravelSteps * Math.abs(c.rangeMax - c.rangeMin),
  }
}

export const DEFAULT_DEVICE_CONFIG: DeviceConfig = {
  backend: 'ossm',
  buttplugUrl: DEFAULT_BUTTPLUG_URL,
  xtoysUrl: DEFAULT_XTOYS_URL,
  ossmUrl: DEFAULT_OSSM_URL,
  enabled: false,
  autoConnect: false,
  rangeMin: 0,
  rangeMax: 1,
  invert: false,
  offsetMs: 0,
  minCmdMs: DEFAULT_LINEARIZE.minCmdMs,
  fitEnabled: true,
  fitMaxSpeed: DEFAULT_FIT.maxSpeed,
  fitMaxAccel: DEFAULT_FIT.maxAccel,
  fitTravelSteps: DEFAULT_FIT.travelSteps,
}

/**
 * Whether a player page that has just opened should start itself.
 *
 * With no machine attached the video is just a video, so it plays on click, as
 * every other viewer does. With one attached it is a script for hardware, and
 * starting unattended is the wrong default: playback waits for a deliberate
 * press. `autoConnect` counts as attached even before the socket is up — it is
 * still opening while the video reaches `canplay`, so deciding on
 * `isConnected()` alone would autoplay into a connection that lands a moment
 * later.
 */
export function shouldAutoplay(
  config: Pick<DeviceConfig, 'enabled' | 'autoConnect'>,
  connected: boolean,
): boolean {
  if (!config.enabled) return true
  return !connected && !config.autoConnect
}

/** Immutable snapshot for React. Replaced wholesale whenever anything changes. */
export type DeviceState = {
  connection: ConnectionState
  /** Last error or status line worth showing next to the connect button. */
  detail: string
  devices: DeviceInfo[]
  /** True while a plan is loaded and output is enabled. */
  armed: boolean
  planCommands: number
  log: string[]
  config: DeviceConfig
  /**
   * True while the bench recorder is armed. In the state rather than read off
   * the recorder, because the HUD has to be able to show that a run is being
   * captured without polling, and a run nobody can see is running is the one
   * that gets thrown away.
   */
  recording: boolean
}

const MAX_LOG = 60

const INITIAL: DeviceState = {
  connection: 'disconnected',
  detail: '',
  devices: [],
  armed: false,
  planCommands: 0,
  log: [],
  config: DEFAULT_DEVICE_CONFIG,
  recording: false,
}

class DeviceManager {
  private state: DeviceState = INITIAL
  private listeners = new Set<() => void>()
  private backend: DeviceBackend | null = null
  private readonly driver = new StrokeDriver()
  /** Markers the current plan was built from, so config changes can replan. */
  private markers: Marker[] = []
  /** The loaded `.bx`'s governor stamp, for the bench header. */
  private governor: BxGovernor = UNKNOWN_GOVERNOR

  // ── React store ────────────────────────────────────────────────────────────

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  getSnapshot = (): DeviceState => this.state

  /** Server render has no device; a stable object keeps hydration quiet. */
  getServerSnapshot = (): DeviceState => INITIAL

  private patch(partial: Partial<DeviceState>): void {
    this.state = { ...this.state, ...partial }
    for (const cb of this.listeners) cb()
  }

  private addLog(line: string): void {
    const stamped = `${new Date().toLocaleTimeString()}  ${line}`
    this.patch({ log: [...this.state.log, stamped].slice(-MAX_LOG) })
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  /**
   * Apply settings. Cheap and idempotent — pages call it on mount and whenever
   * the user saves. Only a backend *kind* or URL change tears down the socket;
   * range, invert and offset take effect on the next command.
   */
  configure(partial: Partial<DeviceConfig>): void {
    const prev = this.state.config
    const config = { ...prev, ...partial }
    this.patch({ config })

    this.driver.setOptions({
      offsetMs: config.offsetMs,
      mapping: {
        rangeMin: config.rangeMin,
        rangeMax: config.rangeMax,
        invert: config.invert,
      },
    })

    const urlFor = (c: DeviceConfig) =>
      c.backend === 'buttplug'
        ? c.buttplugUrl
        : c.backend === 'ossm'
          ? c.ossmUrl
          : c.xtoysUrl
    if (
      this.backend &&
      (prev.backend !== config.backend || urlFor(prev) !== urlFor(config))
    ) {
      this.addLog('Connection settings changed — disconnecting')
      this.disconnect()
    }

    // The fit judges strokes in steps, so with it on the stroke range changes the
    // plan too.
    const fitRangeChanged =
      config.fitEnabled &&
      (prev.rangeMin !== config.rangeMin || prev.rangeMax !== config.rangeMax)
    const changed = PLAN_KEYS.filter((k) => prev[k] !== config[k])
    if (changed.length > 0 || fitRangeChanged) {
      // Logged unconditionally, because the bench runs segments 4, 5 and 7 twice
      // at 100 and at 20 and a run whose threshold is not written down anywhere
      // is not readable afterwards. A change mid-recording also invalidates the
      // header the log was armed with, so the recording stops rather than
      // silently describing a plan that no longer exists.
      const what = changed.map((k) => `${k} ${prev[k]} -> ${config[k]}`)
      if (fitRangeChanged) what.push('stroke range (fit)')
      this.addLog(`${what.join(', ')}, replanning`)
      if (this.state.recording) {
        this.addLog('Bench recording stopped: the plan it was recording has been rebuilt')
        this.stopBench()
      }
      this.replan()
    }
    this.updateArmed()

    if (!config.enabled) this.driver.setRunning(false)
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    // Keyed on the capability rather than on `window`, so this is inert during
    // a server render but still usable from a test runner.
    if (typeof WebSocket === 'undefined') return
    if (this.state.connection === 'connecting') return
    this.disconnect()

    const config = this.state.config
    const backend: DeviceBackend =
      config.backend === 'xtoys'
        ? new XToysBackend({ url: config.xtoysUrl })
        : config.backend === 'ossm'
          ? new OssmDirectBackend({ url: config.ossmUrl })
          : new ButtplugBackend({ url: config.buttplugUrl })

    backend.on('state', (connection, detail) => {
      this.patch({ connection, detail: detail ?? '' })
      this.updateArmed()
    })
    backend.on('devices', (devices) => {
      this.patch({ devices })
      this.updateArmed()
    })
    backend.on('log', (line) => this.addLog(line))

    this.backend = backend
    this.driver.setBackend(backend)
    await backend.connect()
    this.updateArmed()
  }

  disconnect(): void {
    this.driver.setRunning(false)
    this.driver.setBackend(null)
    this.backend?.disconnect()
    this.backend = null
    this.patch({ connection: 'disconnected', devices: [] })
    this.updateArmed()
  }

  /** Ask a Buttplug server to scan for hardware. No-op on other transports. */
  scan(): void {
    if (this.backend instanceof ButtplugBackend) this.backend.startScanning()
  }

  isConnected(): boolean {
    return this.state.connection === 'connected'
  }

  // ── Playback ───────────────────────────────────────────────────────────────

  /**
   * Hand over the markers for the `.bx` currently selected. Planning a
   * full-length track costs a couple of milliseconds, so this is done on load
   * rather than incrementally.
   */
  setMarkers(markers: Marker[], governor: BxGovernor = UNKNOWN_GOVERNOR): void {
    // Before the same-array return: the stamp is cheap and must never go stale.
    this.governor = governor
    // A re-render handing back the same array is not a swap, and gating it
    // would sit the machine out for a stroke for nothing.
    if (markers === this.markers) return
    this.markers = markers
    this.replan(true)
  }

  clearMarkers(): void {
    this.markers = []
    this.governor = UNKNOWN_GOVERNOR
    this.driver.setPlan(EMPTY_PLAN)
    this.driver.setRunning(false)
    this.patch({ planCommands: 0 })
    this.updateArmed()
  }

  /**
   * `swap` is true when the markers are a different track (a difficulty swap
   * or the next playlist entry), which must hand over through the driver's
   * withdrawal gate; false when the same track is being rebuilt.
   */
  private replan(swap = false): void {
    if (this.markers.length < 2) {
      this.driver.setPlan(EMPTY_PLAN)
      this.patch({ planCommands: 0 })
      this.updateArmed()
      return
    }
    const plan: StrokePlan = buildStrokePlan(
      this.markers,
      { ...DEFAULT_LINEARIZE, minCmdMs: this.state.config.minCmdMs },
      fitFor(this.state.config),
    )
    if (swap) this.driver.swapPlan(plan)
    else this.driver.setPlan(plan)
    this.patch({ planCommands: plan.commands.length })
    this.updateArmed()
  }

  /**
   * Per-frame hook.
   *
   * @param planMs  position along the `.bx` timeline in ms — the engine's
   *                `curFrame` converted, which is already smoothed and already
   *                has the video's own path offset applied.
   * @param active  whether the video is genuinely advancing.
   * @param rate    `video.playbackRate`, so move durations come out in wall
   *                time rather than in the plan's media time.
   */
  tick(planMs: number, active: boolean, rate = 1): void {
    this.driver.tick(planMs, active, rate)
  }

  /** Live counters for the diagnostics panel. Read, never subscribed. */
  get stats() {
    return this.driver.stats
  }

  // ── Bench recording ────────────────────────────────────────────────────────
  //
  // The middle layer of the bench chain: what the fork commanded, as against the
  // `.bx` on disk and the carriage the camera sees. See `bench.ts` for why this
  // is part of the instrument rather than an improvement to it, and for why it
  // is not evidence about `k`.

  private readonly recorder = new BenchRecorder()

  /**
   * Arm the recorder for one run. `label` is whatever the page knows about what
   * is playing and goes into the header verbatim.
   *
   * **The header is taken at arm time and `minCmdMs` is the one field that makes
   * the log readable**, so arming after changing the threshold is the correct
   * order and arming before it silently records the wrong number. `configure`
   * replans on a `minCmdMs` change, which is also the moment the plan the log
   * describes stops existing, so a change while armed disarms rather than
   * carrying on.
   */
  startBench(label = ''): void {
    const c = this.state.config
    this.recorder.arm({
      startedAt: new Date().toISOString(),
      minCmdMs: c.minCmdMs,
      leadMs: this.driver.getOptions().leadMs,
      offsetMs: c.offsetMs,
      rangeMin: c.rangeMin,
      rangeMax: c.rangeMax,
      invert: c.invert,
      backend: c.backend,
      planCommands: this.state.planCommands,
      label,
      fps: FPS,
      governorLevel: this.governor.governorLevel,
      capsHash: this.governor.capsHash,
      fit: fitFor(c) ?? null,
    })
    this.driver.setRecorder(this.recorder)
    this.addLog(`Bench recording armed at minCmdMs=${c.minCmdMs}`)
    this.patch({ recording: true })
  }

  stopBench(): void {
    if (!this.recorder.isArmed()) return
    this.driver.setRecorder(null)
    this.addLog(`Bench recording stopped, ${this.recorder.count()} moves`)
    this.patch({ recording: false })
  }

  benchCount(): number {
    return this.recorder.count()
  }

  /** The log as CSV. Kept as a string so the caller decides where it goes. */
  benchCsv(): string {
    return this.recorder.toCsv()
  }

  /**
   * Stop the machine when the tab is hidden.
   *
   * Backgrounding a tab suspends `requestAnimationFrame`, which means `tick`
   * stops being called while the video keeps playing. Without this the device
   * would hold — or finish — whatever move it was last given and then sit
   * there, and on return the clock jump would be handled as a seek. Halting
   * explicitly is both safer and less surprising.
   */
  private watchVisibility(): void {
    if (typeof document === 'undefined') return
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.driver.halt()
    })
  }

  /** Called once, from the singleton construction below. */
  init(): this {
    this.watchVisibility()
    this.driver.onSwap = (phase) =>
      this.addLog(
        phase === 'leave'
          ? 'Track swap: finishing the old track until the machine is out'
          : phase === 'retract'
            ? 'Track swap: old track did not come out, retracting slowly'
            : phase === 'out'
              ? 'Track swap: out, holding until the new track comes out'
              : 'Track swap: new track joined',
      )
    return this
  }

  private updateArmed(): void {
    const armed =
      this.state.config.enabled &&
      this.state.connection === 'connected' &&
      this.state.planCommands > 0
    this.driver.setRunning(armed)
    if (armed !== this.state.armed) this.patch({ armed })
  }
}

/**
 * Survives Fast Refresh, which would otherwise re-evaluate the module and drop
 * a live socket on every edit.
 */
const globalKey = '__bxDeviceManager'
type GlobalWithManager = typeof globalThis & { [globalKey]?: DeviceManager }

export const deviceManager: DeviceManager =
  (globalThis as GlobalWithManager)[globalKey] ??
  ((globalThis as GlobalWithManager)[globalKey] = new DeviceManager().init())
