/**
 * Direct transport to the OSSM Sauce app's XToys bridge.
 *
 * The Sauce app runs a WebSocket *server* (default port 8080) that
 * accepts a tiny JSON command set and forwards it to the ESP32 as a
 * `SMOOTH_MOVE`. Compared with going through Intiface this drops two hops and
 * a protocol translation, so it is the lower-latency option when the target is
 * specifically an OSSM.
 *
 * Two settings inside OSSM Sauce decide whether this works properly, and both
 * default against us — see `SETUP_NOTES` below.
 *
 * There is no handshake, no authentication and no reply traffic of any kind:
 * connection state is exactly "is the socket open".
 */

import {
  describeConnectFailure,
  Emitter,
  type BackendKind,
  type ConnectionState,
  type DeviceBackend,
  type DeviceInfo,
} from './types'

/**
 * An IP literal rather than `localhost`: Chrome's Local Network Access gate
 * (147+) can only classify the address space before resolution for literals, so
 * `127.0.0.1` keeps working from origins where `localhost` would not.
 */
export const DEFAULT_XTOYS_URL = 'ws://127.0.0.1:8080'

/**
 * Surfaced in the settings UI. These are not optional niceties — with the stock
 * OSSM Sauce configuration the bridge silently rewrites every stroke we send.
 */
export const SETUP_NOTES = [
  'OSSM Sauce → Bridge Settings → Bridge Mode: XToys, then press Enable.',
  'Tick "Get stroke duration from command" — otherwise every stroke is forced ' +
    'to 1000 / Max Message Frequency ms and ignores our timing entirely.',
  'Set Speed Overrides → Minimum Duration to 50 ms or so. It defaults to ' +
    '500 ms, which stretches short strokes and puts the machine behind the video.',
] as const

export type XToysOptions = {
  url: string
}

export const DEFAULT_XTOYS_OPTIONS: XToysOptions = { url: DEFAULT_XTOYS_URL }

export class XToysBackend extends Emitter implements DeviceBackend {
  readonly kind: BackendKind = 'xtoys'

  private opts: XToysOptions
  private ws: WebSocket | null = null
  private _state: ConnectionState = 'disconnected'
  private _devices: DeviceInfo[] = []

  constructor(opts: Partial<XToysOptions> = {}) {
    super()
    this.opts = { ...DEFAULT_XTOYS_OPTIONS, ...opts }
  }

  get state(): ConnectionState {
    return this._state
  }

  get devices(): DeviceInfo[] {
    return this._devices
  }

  setOptions(partial: Partial<XToysOptions>): void {
    this.opts = { ...this.opts, ...partial }
  }

  async connect(): Promise<void> {
    this.disconnect()
    this.setState('connecting')

    let ws: WebSocket
    try {
      ws = new WebSocket(this.opts.url)
    } catch (e) {
      this.setState('error', describeFailure(this.opts.url, e))
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
        // The bridge announces nothing, so an open socket is the whole
        // handshake. It is also not proof the OSSM itself is connected — the
        // app drops commands when its own device link is down, silently.
        this._devices = [{ name: 'OSSM (via OSSM Sauce)', linear: true }]
        this.emit('devices', this._devices)
        this.setState('connected')
        this.emit(
          'log',
          'Connected. Note the bridge does not report whether the OSSM itself is online.',
        )
        done()
      }

      ws.onerror = () => {
        this.setState('error', describeFailure(this.opts.url))
        done()
      }

      ws.onclose = (ev) => {
        this.ws = null
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
    const ws = this.ws
    this.ws = null
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close()
      } catch {
        /* nothing useful to do */
      }
    }
    if (this._state !== 'error') this.setState('disconnected')
  }

  move(pos: number, durMs: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    // The bridge requires *both* fields and drops the command if either is
    // missing; `position` is a percentage, not a 0..1 fraction.
    const body = {
      mode: 'position',
      position: clamp(pos * 100, 0, 100),
      duration: Math.max(1, Math.round(durMs)),
    }
    try {
      this.ws.send(JSON.stringify(body))
    } catch {
      // Reported via onclose; never throw on the render path.
    }
  }

  /**
   * No-op by design. The XToys bridge has no stop or halt command — the only
   * thing it can be told is a new destination. Cutting motion short would mean
   * commanding a move to wherever the machine currently is, which we cannot
   * know, so the safe behaviour is to let the stroke in flight finish and hold.
   */
  stop(): void {}

  private setState(state: ConnectionState, detail?: string): void {
    this._state = state
    this.emit('state', state, detail)
    if (detail) this.emit('log', detail)
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function describeFailure(url: string, e?: unknown): string {
  return describeConnectFailure(
    url,
    'Is OSSM Sauce running, with the XToys bridge enabled?',
    e,
  )
}
