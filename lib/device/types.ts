/**
 * The contract every device transport implements, plus the depth→device
 * position mapping shared by all of them.
 *
 * Backends are deliberately dumb: connect, move, stop. All timing, seeking and
 * rate-limiting lives in `driver.ts`, so adding a transport means implementing
 * three methods and nothing else.
 */

export type BackendKind = 'buttplug' | 'xtoys' | 'ossm'

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'

/** What the far end told us it is. Shown in the UI; never load-bearing. */
export type DeviceInfo = {
  /** Human-readable device name, e.g. "TCode v0.3 (Single Linear Axis)". */
  name: string
  /** Transport-specific handle (Buttplug device index, etc). */
  index?: number
  /** Whether the device accepts absolute positional moves. */
  linear: boolean
}

export type BackendEvents = {
  state: (state: ConnectionState, detail?: string) => void
  devices: (devices: DeviceInfo[]) => void
  /** Human-readable line for the diagnostics log in the UI. */
  log: (line: string) => void
}

/**
 * Easing hint carried alongside a move, in `.bx`/Godot numbering. Transports
 * that can reproduce easing on-device (OSSM natively) use it; the rest ignore
 * it, because `driver.ts` has already subdivided the curve for them.
 */
export type EaseHint = { trans: number; ease: number }

export interface DeviceBackend {
  readonly kind: BackendKind

  connect(): Promise<void>
  disconnect(): void

  /**
   * Be at `pos` (0..1, already range-mapped and inverted) in `durMs`.
   *
   * Fire-and-forget: a move issued while another is in flight replaces it.
   * Implementations must never throw — a dead socket is reported through the
   * `state` event, not by rejecting a move on the render path.
   */
  move(pos: number, durMs: number, hint?: EaseHint): void

  /** Halt motion and cancel anything queued. Safe to call when disconnected. */
  stop(): void

  on<K extends keyof BackendEvents>(event: K, cb: BackendEvents[K]): void

  /** Currently known devices — the same list last emitted via `devices`. */
  readonly devices: DeviceInfo[]
  readonly state: ConnectionState
}

// ── Output mapping ───────────────────────────────────────────────────────────

export type OutputMapping = {
  /** Bottom of the usable stroke, 0..1. */
  rangeMin: number
  /** Top of the usable stroke, 0..1. */
  rangeMax: number
  /** Swap the ends — `.bx` depth 1 is "top", which not every rig agrees with. */
  invert: boolean
}

export const DEFAULT_MAPPING: OutputMapping = {
  rangeMin: 0,
  rangeMax: 1,
  invert: false,
}

/**
 * Raw `.bx` depth → device position.
 *
 * Clamps first: Back/Elastic easing legitimately overshoots outside 0..1, which
 * looks fine on a canvas and is a hard mechanical limit on a machine.
 */
export function mapDepth(depth: number, m: OutputMapping): number {
  const clamped = depth < 0 ? 0 : depth > 1 ? 1 : depth
  const d = m.invert ? 1 - clamped : clamped
  // Tolerate a reversed range rather than emitting nonsense.
  const lo = Math.min(m.rangeMin, m.rangeMax)
  const hi = Math.max(m.rangeMin, m.rangeMax)
  return lo + (hi - lo) * d
}

/** Minimal event emitter — the backends' only shared implementation detail. */
/**
 * Turn a failed connection into something actionable.
 *
 * The browser rules here are easy to get wrong, so they are worth stating: a
 * `ws://` URL pointing at **loopback** is *not* mixed content. W3C Secure
 * Contexts treats 127.0.0.0/8 and ::1 as potentially trustworthy regardless of
 * scheme, which is exactly why every local hardware bridge works this way. The
 * genuine failure modes are narrower:
 *
 *  - a **non-loopback** `ws://` host from an https page really is blocked;
 *  - Chrome 147+ gates loopback WebSockets from a *public* https origin behind
 *    a Local Network Access prompt, and can only resolve the address space
 *    ahead of time for IP literals — so `127.0.0.1` works there where
 *    `localhost` may not;
 *  - Safari blocks loopback `ws://` from https outright, with no workaround.
 *
 * Served over http://localhost, as this app normally is, none of it applies.
 */
export function describeConnectFailure(
  url: string,
  /** Full sentence appended to the generic failure, e.g. "Is X running?". */
  hint: string,
  e?: unknown,
): string {
  const onHttps =
    typeof window !== 'undefined' && window.location.protocol === 'https:'
  if (onHttps && url.startsWith('ws://')) {
    const host = hostOf(url)
    if (host && !isLoopback(host)) {
      return (
        `${url} is not a loopback address, and browsers block insecure ` +
        `WebSockets to anything else from an https page. Open this app over ` +
        `http://localhost, or point the URL at 127.0.0.1.`
      )
    }
    return (
      `Could not reach ${url}. From an https page, Chrome may ask for Local ` +
      `Network Access permission first, and Safari blocks local WebSockets ` +
      `entirely. Opening this app over http://localhost avoids both.`
    )
  }
  const why = e instanceof Error ? `: ${e.message}` : ''
  return `Could not connect to ${url}${why}. ${hint}`
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '')
  return (
    bare === 'localhost' ||
    bare === '::1' ||
    /^127\./.test(bare) ||
    bare.endsWith('.localhost')
  )
}

type AnyListener = (...args: never[]) => void

export class Emitter {
  // Stored untyped and cast at both ends: a mapped-type store can't be indexed
  // by a generic key without TypeScript collapsing the union of handlers.
  private listeners = new Map<keyof BackendEvents, AnyListener[]>()

  on<K extends keyof BackendEvents>(event: K, cb: BackendEvents[K]): void {
    const list = this.listeners.get(event)
    if (list) list.push(cb as AnyListener)
    else this.listeners.set(event, [cb as AnyListener])
  }

  protected emit<K extends keyof BackendEvents>(
    event: K,
    ...args: Parameters<BackendEvents[K]>
  ): void {
    for (const cb of this.listeners.get(event) ?? []) {
      try {
        ;(cb as (...a: unknown[]) => void)(...args)
      } catch {
        // A broken listener must not take down the transport.
      }
    }
  }
}
