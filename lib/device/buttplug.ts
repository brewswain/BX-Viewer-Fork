/**
 * A Buttplug client, spoken directly over a raw WebSocket.
 *
 * Why not the `buttplug` npm package: this repo lives on an exFAT volume, where
 * bun cannot rewrite `bun.lock` (see the notes in `next.config.ts` for the
 * related Turbopack fallout). Adding a dependency is therefore a manual,
 * error-prone operation for anyone cloning this. The subset of the protocol a
 * video player needs is a few hundred lines of JSON, so it is implemented here
 * and the install stays dependency-free.
 *
 * Spec version 3 is requested deliberately. Intiface Central 3.1 ships a
 * Buttplug 10 server whose native message spec is v4, but v4 replaced
 * `LinearCmd` with a feature/output model that is still in flux — and the
 * OSSM Sauce app's own bridge connects to the same server with
 * `MessageVersion: 3` and works, which makes v3 the verified-compatible
 * choice rather than the merely-documented one.
 *
 * Wire format: every frame is a JSON *array* of message objects, each a
 * single-key object — `[{"RequestServerInfo": {...}}]`.
 */

import {
  describeConnectFailure,
  Emitter,
  type BackendKind,
  type ConnectionState,
  type DeviceBackend,
  type DeviceInfo,
} from './types'

/** Intiface Central's default client-facing websocket. */
export const DEFAULT_BUTTPLUG_URL = 'ws://127.0.0.1:12345'

type Json = Record<string, unknown>

/** A device as the server describes it in `DeviceList`/`DeviceAdded`. */
type ServerDevice = {
  DeviceName?: string
  DeviceDisplayName?: string
  DeviceIndex?: number
  DeviceMessageTimingGap?: number
  DeviceMessages?: Record<string, unknown>
}

export type ButtplugOptions = {
  url: string
  clientName: string
  /** Ask the server to scan for hardware on connect. */
  autoScan: boolean
  /**
   * Index of the device to drive, or `null` for "first one that can do linear
   * motion". Devices come and go, so this is matched on every device list.
   */
  deviceIndex: number | null
}

export const DEFAULT_BUTTPLUG_OPTIONS: ButtplugOptions = {
  url: DEFAULT_BUTTPLUG_URL,
  clientName: 'BounceX Viewer',
  autoScan: true,
  deviceIndex: null,
}

export class ButtplugBackend extends Emitter implements DeviceBackend {
  readonly kind: BackendKind = 'buttplug'

  private opts: ButtplugOptions
  private ws: WebSocket | null = null
  private nextId = 1
  private pingTimer: ReturnType<typeof setInterval> | null = null

  /** Raw device records by index, so the UI can show everything present. */
  private serverDevices = new Map<number, ServerDevice>()
  private target: { index: number; gap: number } | null = null
  /** Enforces `DeviceMessageTimingGap`; devices drop or queue faster traffic. */
  private lastSendAt = 0
  /** Deferred send when the timing gap swallowed the most recent move. */
  private pendingMove: { pos: number; dur: number } | null = null
  private pendingTimer: ReturnType<typeof setTimeout> | null = null

  private _state: ConnectionState = 'disconnected'
  private _devices: DeviceInfo[] = []

  constructor(opts: Partial<ButtplugOptions> = {}) {
    super()
    this.opts = { ...DEFAULT_BUTTPLUG_OPTIONS, ...opts }
  }

  get state(): ConnectionState {
    return this._state
  }

  get devices(): DeviceInfo[] {
    return this._devices
  }

  /** The device currently being driven, if any. */
  get targetIndex(): number | null {
    return this.target?.index ?? null
  }

  setOptions(partial: Partial<ButtplugOptions>): void {
    this.opts = { ...this.opts, ...partial }
    // A device re-pick is cheap and makes the setting take effect immediately.
    if (this._state === 'connected') this.pickTarget()
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.disconnect()
    this.setState('connecting')

    let ws: WebSocket
    try {
      ws = new WebSocket(this.opts.url)
    } catch (e) {
      // Malformed URL, or a scheme the page's origin is not allowed to open.
      this.setState('error', connectFailure(this.opts.url, e))
      return
    }
    this.ws = ws

    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }

      ws.onopen = () => {
        this.emit('log', `Connected to ${this.opts.url}`)
        this.send({
          RequestServerInfo: {
            Id: this.nextId++,
            ClientName: this.opts.clientName,
            MessageVersion: 3,
          },
        })
      }

      ws.onmessage = (ev) => {
        this.onMessage(ev.data)
        // Resolve once the handshake has actually completed, not merely when
        // the socket opened — a server that never answers should read as a
        // failure, and `ServerInfo` is what flips us to `connected`.
        if (this._state === 'connected') done()
      }

      ws.onerror = () => {
        this.setState('error', connectFailure(this.opts.url))
        done()
      }

      ws.onclose = (ev) => {
        this.stopPing()
        this.ws = null
        this.target = null
        this.serverDevices.clear()
        this._devices = []
        this.emit('devices', this._devices)
        if (this._state !== 'error') {
          this.setState(
            'disconnected',
            ev.reason || (ev.wasClean ? undefined : 'Connection lost'),
          )
        }
        done()
      }

      // Don't hang forever on a host that accepts TCP but never speaks.
      setTimeout(() => {
        if (this._state !== 'connected') {
          this.setState('error', `No response from ${this.opts.url}`)
          try {
            ws.close()
          } catch {
            /* already closing */
          }
        }
        done()
      }, 5000)
    })
  }

  disconnect(): void {
    this.stopPing()
    this.clearPending()
    const ws = this.ws
    this.ws = null
    this.target = null
    this.serverDevices.clear()
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close()
      } catch {
        /* nothing useful to do */
      }
    }
    if (this._state !== 'error') this.setState('disconnected')
  }

  /** Ask the server to look for new hardware. */
  startScanning(): void {
    this.send({ StartScanning: { Id: this.nextId++ } })
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  move(pos: number, durMs: number): void {
    const target = this.target
    if (!target || !this.isOpen()) return

    const duration = Math.max(1, Math.round(durMs))
    const position = clamp01(pos)

    // Respect the device's stated minimum spacing. Rather than dropping the
    // command — which would leave the device parked at a stale position — hold
    // the newest one and fire it when the gap expires.
    if (target.gap > 0) {
      const now = Date.now()
      const wait = target.gap - (now - this.lastSendAt)
      if (wait > 0) {
        this.pendingMove = { pos: position, dur: duration }
        if (!this.pendingTimer) {
          this.pendingTimer = setTimeout(() => {
            this.pendingTimer = null
            const p = this.pendingMove
            this.pendingMove = null
            if (p) this.sendLinear(p.pos, p.dur)
          }, wait)
        }
        return
      }
    }
    this.clearPending()
    this.sendLinear(position, duration)
  }

  stop(): void {
    this.clearPending()
    const target = this.target
    if (!target || !this.isOpen()) return
    this.send({
      StopDeviceCmd: { Id: this.nextId++, DeviceIndex: target.index },
    })
  }

  private sendLinear(position: number, duration: number): void {
    const target = this.target
    if (!target) return
    this.lastSendAt = Date.now()
    this.send({
      LinearCmd: {
        Id: this.nextId++,
        DeviceIndex: target.index,
        Vectors: [{ Index: 0, Duration: duration, Position: position }],
      },
    })
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────

  private isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  private send(msg: Json): void {
    if (!this.isOpen()) return
    try {
      this.ws!.send(JSON.stringify([msg]))
    } catch {
      // A socket that died between the readyState check and here surfaces
      // through onclose; a throw on the render path would not be recoverable.
    }
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      this.emit('log', 'Ignored a non-JSON frame from the server')
      return
    }
    if (!Array.isArray(parsed)) return

    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue
      for (const [name, body] of Object.entries(entry as Json)) {
        this.handle(name, (body ?? {}) as Json)
      }
    }
  }

  private handle(name: string, body: Json): void {
    switch (name) {
      case 'ServerInfo': {
        const serverName = String(body.ServerName ?? 'Buttplug server')
        const maxPing = Number(body.MaxPingTime ?? 0)
        this.emit('log', `Server: ${serverName} (spec v${body.MessageVersion})`)
        this.setState('connected')
        // A non-zero MaxPingTime is a dead-man switch: miss it and the server
        // drops us mid-scene. Ping at half the interval for margin.
        if (maxPing > 0) {
          this.pingTimer = setInterval(
            () => this.send({ Ping: { Id: this.nextId++ } }),
            Math.max(250, Math.floor(maxPing / 2)),
          )
        }
        this.send({ RequestDeviceList: { Id: this.nextId++ } })
        if (this.opts.autoScan) this.startScanning()
        break
      }

      case 'DeviceList': {
        const list = Array.isArray(body.Devices)
          ? (body.Devices as ServerDevice[])
          : []
        this.serverDevices.clear()
        for (const d of list) {
          if (typeof d.DeviceIndex === 'number') {
            this.serverDevices.set(d.DeviceIndex, d)
          }
        }
        this.refreshDevices()
        break
      }

      case 'DeviceAdded': {
        const d = body as ServerDevice
        if (typeof d.DeviceIndex === 'number') {
          this.serverDevices.set(d.DeviceIndex, d)
          this.emit('log', `Device added: ${deviceLabel(d)}`)
          this.refreshDevices()
        }
        break
      }

      case 'DeviceRemoved': {
        const idx = Number(body.DeviceIndex)
        const gone = this.serverDevices.get(idx)
        this.serverDevices.delete(idx)
        if (gone) this.emit('log', `Device removed: ${deviceLabel(gone)}`)
        this.refreshDevices()
        break
      }

      case 'ScanningFinished':
        this.emit('log', 'Scanning finished')
        break

      case 'Error':
        this.emit('log', `Server error: ${String(body.ErrorMessage ?? 'unknown')}`)
        break

      default:
        // Ok / Ping replies and anything a later spec adds: nothing to do. The
        // client is fire-and-forget, so command acks carry no information.
        break
    }
  }

  private refreshDevices(): void {
    this._devices = [...this.serverDevices.values()]
      .map((d) => ({
        name: deviceLabel(d),
        index: d.DeviceIndex,
        linear: hasLinear(d),
      }))
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    this.emit('devices', this._devices)
    this.pickTarget()
  }

  /**
   * Choose which device to drive: the configured index if it is present and
   * capable, otherwise the first device that supports linear motion.
   */
  private pickTarget(): void {
    const previous = this.target?.index ?? null
    let chosen: ServerDevice | undefined

    if (this.opts.deviceIndex !== null) {
      const d = this.serverDevices.get(this.opts.deviceIndex)
      if (d && hasLinear(d)) chosen = d
    }
    if (!chosen) {
      chosen = [...this.serverDevices.values()]
        .sort((a, b) => (a.DeviceIndex ?? 0) - (b.DeviceIndex ?? 0))
        .find(hasLinear)
    }

    this.target = chosen
      ? {
          index: chosen.DeviceIndex as number,
          gap: Number(chosen.DeviceMessageTimingGap ?? 0),
        }
      : null

    if (this.target?.index !== previous) {
      this.clearPending()
      if (this.target) {
        this.emit('log', `Driving: ${deviceLabel(chosen!)}`)
      } else if (this.serverDevices.size > 0) {
        this.emit(
          'log',
          'No connected device supports positional (linear) control',
        )
      }
    }
  }

  private clearPending(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    this.pendingTimer = null
    this.pendingMove = null
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private setState(state: ConnectionState, detail?: string): void {
    this._state = state
    this.emit('state', state, detail)
    if (detail) this.emit('log', detail)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function deviceLabel(d: ServerDevice): string {
  return String(d.DeviceDisplayName || d.DeviceName || `Device ${d.DeviceIndex}`)
}

/**
 * Whether the device accepts `LinearCmd`. The spec allows the value to be an
 * array of per-actuator descriptors or a bare object, so presence of the key is
 * the reliable test — an empty array means "declared but no actuators", which
 * is not usable.
 */
function hasLinear(d: ServerDevice): boolean {
  const msgs = d.DeviceMessages
  if (!msgs || typeof msgs !== 'object') return false
  const linear = (msgs as Record<string, unknown>).LinearCmd
  if (linear === undefined) return false
  if (Array.isArray(linear)) return linear.length > 0
  return true
}

function connectFailure(url: string, e?: unknown): string {
  return describeConnectFailure(
    url,
    'Is Intiface Central running, with its server started?',
    e,
  )
}
