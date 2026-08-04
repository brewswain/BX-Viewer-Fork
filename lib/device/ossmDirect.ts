/**
 * Raw transport to the OSSM, through OSSM Sauce's MCP command server.
 *
 * The other two backends hand a *description* of a move to OSSM Sauce and let it
 * decide what the machine actually does. Both of its bridges rewrite what we
 * send before forwarding it:
 *
 *  - every stroke is clamped to `min_move_duration` (500 ms out of the box), and
 *  - every stroke is re-eased with the app's `Stroke Smoothing` dropdown, which
 *    defaults to Sine and is never written to `UserSettings.cfg` — so it resets
 *    on every launch and has to be set to `Linear` by hand, forever.
 *
 * The MCP server does neither. `POST /send_binary` takes hex and broadcasts the
 * bytes to the ESP32 untouched (`websocket_mcp_bridge.gd:47`), so we assemble
 * the `SMOOTH_MOVE` frame ourselves and choose the transition and easing bytes
 * directly. No clamp, no smoothing override, nothing to set by hand.
 *
 * What the firmware still enforces, which is exactly what should be enforced:
 * depth 0..10000 is mapped into the user's configured range limit and duration
 * is clamped to a 20 ms floor (`main.cpp:283`), so this is no more privileged
 * than the bridges — it is the same command with fields we control.
 *
 * The trade is transport quality. This is HTTP/1.0-ish: a hand-rolled TCP
 * server that parses one request per connection and hangs up, so every move is
 * a fresh connection. On loopback at 3–8 commands a second that is fine, but it
 * is why moves are coalesced rather than queued.
 */

import {
  Emitter,
  type BackendKind,
  type ConnectionState,
  type DeviceBackend,
  type DeviceInfo,
} from './types'

/** MCP bridge default. IP literal for the same Chrome LNA reason as elsewhere. */
export const DEFAULT_OSSM_URL = 'http://127.0.0.1:8081'

export const SETUP_NOTES = [
  'OSSM Sauce → Bridge Settings → Bridge Mode: MCP, then press Enable.',
  'Nothing else. Minimum Duration and Stroke Smoothing do not apply to this ' +
    'route — the commands go straight through to the machine.',
] as const

/** Firmware command byte. `main.cpp:44`. */
const CMD_SMOOTH_MOVE = 0x0f

/**
 * Firmware `TransType`/`EaseType` (`MotorMovement.h:33`). We always send linear:
 * `driver.ts` has already subdivided each curve into straight segments, so the
 * machine reproducing them as straight lines *is* the on-screen easing. The
 * `EaseHint` is ignored for the same reason — and the firmware's `interpolate`
 * ignores the ease byte outright when the transition is linear.
 *
 * Sending the `.bx` transition natively instead would be a planner change, not
 * a transport one, and needs a Godot→firmware translation table: the two enums
 * agree on the name but not the number for five of eight values.
 */
const TRANS_LINEAR = 0
const EASE_IN = 0

/** How often to re-ask the app whether the machine is actually attached. */
const STATUS_POLL_MS = 2000
const REQUEST_TIMEOUT_MS = 1500

export type OssmDirectOptions = {
  url: string
}

export const DEFAULT_OSSM_OPTIONS: OssmDirectOptions = { url: DEFAULT_OSSM_URL }

type StatusReply = {
  websocket_listening?: boolean
  connected_clients?: number
  ossm_connected?: boolean
  server_started?: boolean
}

export class OssmDirectBackend extends Emitter implements DeviceBackend {
  readonly kind: BackendKind = 'ossm'

  private opts: OssmDirectOptions
  private _state: ConnectionState = 'disconnected'
  private _devices: DeviceInfo[] = []
  private poll: ReturnType<typeof setInterval> | null = null

  /** Bounded to one request at a time; see `pending`. */
  private inFlight = false
  /** Newest move that arrived while a request was open. Older ones are dropped
   *  deliberately — a superseded position is worthless, and queueing them would
   *  make the machine replay a backlog after any hiccup. */
  private pending: Uint8Array | null = null
  private ossmAttached = false

  constructor(opts: Partial<OssmDirectOptions> = {}) {
    super()
    this.opts = { ...DEFAULT_OSSM_OPTIONS, ...opts }
  }

  get state(): ConnectionState {
    return this._state
  }

  get devices(): DeviceInfo[] {
    return this._devices
  }

  setOptions(partial: Partial<OssmDirectOptions>): void {
    this.opts = { ...this.opts, ...partial }
  }

  async connect(): Promise<void> {
    this.disconnect()
    this.setState('connecting')

    const status = await this.fetchStatus()
    if (!status) {
      this.setState('error', describeFailure(this.opts.url))
      return
    }

    this.applyStatus(status)
    this.setState('connected')
    this.emit(
      'log',
      status.ossm_connected
        ? 'MCP bridge reachable, OSSM attached.'
        : 'MCP bridge reachable, but the OSSM is not attached to OSSM Sauce yet.',
    )

    this.poll = setInterval(() => void this.refresh(), STATUS_POLL_MS)
  }

  disconnect(): void {
    if (this.poll !== null) {
      clearInterval(this.poll)
      this.poll = null
    }
    this.pending = null
    this.ossmAttached = false
    if (this._devices.length) {
      this._devices = []
      this.emit('devices', this._devices)
    }
    if (this._state !== 'error') this.setState('disconnected')
  }

  move(pos: number, durMs: number): void {
    if (this._state !== 'connected') return

    const frame = new Uint8Array(10)
    const view = new DataView(frame.buffer)
    // Little-endian throughout: the ESP32 is LE and the firmware memcpy's these
    // bytes straight into a packed struct, so this mirrors what Godot's
    // `PackedByteArray.encode_*` produces in the stock bridges.
    view.setUint8(0, CMD_SMOOTH_MOVE)
    view.setUint32(1, Math.max(20, Math.round(durMs)), true)
    view.setUint16(5, Math.round(clamp(pos, 0, 1) * 10000), true)
    view.setUint8(7, TRANS_LINEAR)
    view.setUint8(8, EASE_IN)
    view.setUint8(9, 0) // auxiliary — unused by SMOOTH_MOVE

    if (this.inFlight) {
      this.pending = frame
      return
    }
    void this.send(frame)
  }

  /**
   * No-op, as with the XToys bridge: the firmware's `SMOOTH_MOVE` mode has no
   * halt, only a new destination, and stopping mid-stroke would mean commanding
   * a move to wherever the carriage currently is — which we cannot read back.
   * The driver stops issuing moves on pause, so the stroke in flight finishes
   * and the machine holds.
   */
  stop(): void {
    this.pending = null
  }

  // ── Transport ──────────────────────────────────────────────────────────────

  private async send(frame: Uint8Array): Promise<void> {
    this.inFlight = true
    try {
      await this.post('/send_binary', { hex_data: toHex(frame) })
    } catch {
      // Never throw on the render path. A persistent failure surfaces through
      // the status poll, which is the thing that can tell connected from gone.
    } finally {
      this.inFlight = false
      const next = this.pending
      this.pending = null
      if (next && this._state === 'connected') void this.send(next)
    }
  }

  private async refresh(): Promise<void> {
    const status = await this.fetchStatus()
    if (!status) {
      this.setState('error', `Lost the MCP bridge at ${this.opts.url}.`)
      this.disconnect()
      return
    }
    this.applyStatus(status)
  }

  private applyStatus(status: StatusReply): void {
    const attached = status.ossm_connected === true
    if (attached === this.ossmAttached && this._devices.length) return
    this.ossmAttached = attached
    // Reported rather than inferred: this is the one route that can actually
    // tell whether the machine is on the other end of OSSM Sauce.
    this._devices = attached
      ? [{ name: 'OSSM (direct, via MCP bridge)', linear: true }]
      : []
    this.emit('devices', this._devices)
    if (!attached) {
      this.emit('log', 'OSSM is not attached to OSSM Sauce — commands go nowhere.')
    }
  }

  private async fetchStatus(): Promise<StatusReply | null> {
    try {
      const body = await this.post('/status', {})
      return JSON.parse(body) as StatusReply
    } catch {
      return null
    }
  }

  private async post(path: string, body: unknown): Promise<string> {
    const res = await fetch(this.opts.url.replace(/\/$/, '') + path, {
      method: 'POST',
      // Deliberately *not* application/json. The server answers non-POST with
      // 405, so a CORS preflight would fail outright; a text/plain body keeps
      // this a simple request that never triggers one. The handler only
      // JSON-parses the body and never looks at the content type.
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(body),
      signal: timeoutSignal(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  }

  private setState(state: ConnectionState, detail?: string): void {
    this._state = state
    this.emit('state', state, detail)
    if (detail) this.emit('log', detail)
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  // Available everywhere this app supports, but the test runner and older
  // WebViews are not worth crashing over.
  if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
    return AbortSignal.timeout(ms)
  }
  return undefined
}

function describeFailure(url: string): string {
  return (
    `Could not reach the OSSM Sauce MCP bridge at ${url}. Is OSSM Sauce ` +
    `running, with Bridge Mode set to MCP and the bridge enabled?`
  )
}
