/**
 * Turning `.bx` markers into a device stroke plan.
 *
 * A `.bx` marker pair describes a *curve*: "go from depth A to depth B over N
 * frames, following Godot tween `trans`/`ease`". Almost no device speaks that.
 * The common denominator across transports (Buttplug `LinearCmd`, OSSM Sauce
 * moves) is "be at position P in D milliseconds", travelling linearly.
 *
 * So this module does two things, kept separate on purpose:
 *
 *   `buildSegments`  — lossless: markers → timed curve segments. A backend that
 *                      *can* reproduce easing consumes these.
 *   `linearize`      — lossy: segments → a flat list of linear moves, adaptively
 *                      subdividing only the curves that actually deviate from a
 *                      straight line, then rate-limiting to what a device can
 *                      physically accept.
 *
 * Everything here is time-in-milliseconds against *video* time, and position in
 * the raw `.bx` 0..1 depth space. Stroke-range/invert mapping is deliberately
 * NOT applied — that happens at send time so the settings take effect live
 * without replanning.
 */

import { FPS } from '@/lib/player/constants'
import { godotEase } from '@/lib/player/bx'
import type { Marker } from '@/lib/player/types'

/** A `.bx` curve between two markers, in milliseconds of video time. */
export type Segment = {
  /** Start of the segment (ms). */
  tStart: number
  /** End of the segment (ms). */
  tEnd: number
  /** Depth at `tStart` (0..1). */
  from: number
  /** Depth at `tEnd` (0..1). */
  to: number
  /** Godot transition type of the *incoming* marker — see `godotEase`. */
  trans: number
  /** Godot ease type of the *incoming* marker. */
  ease: number
}

/** "Be at `pos` `dur` ms from `t`, moving linearly." */
export type StrokeCmd = {
  /** When to *issue* this move, in ms of video time. */
  t: number
  /** Target depth (0..1, raw `.bx` space). */
  pos: number
  /** Travel time in ms. */
  dur: number
}

export type LinearizeOptions = {
  /**
   * Shortest move a device will accept. Commands are merged until they are at
   * least this long. 100 ms is a safe floor across Buttplug hardware; OSSM over
   * a local socket copes with far less.
   */
  minCmdMs: number
  /**
   * Longest a single move may run before being split. Keeps a slow ramp from
   * becoming one enormous command a seek can't interrupt cleanly.
   */
  maxCmdMs: number
  /**
   * How far (in 0..1 depth) a linear approximation may stray from the true
   * eased curve before the segment is subdivided.
   */
  tolerance: number
}

export const DEFAULT_LINEARIZE: LinearizeOptions = {
  minCmdMs: 100,
  maxCmdMs: 1000,
  tolerance: 0.04,
}

const frameToMs = (frame: number) => (frame / FPS) * 1000

// ── Segments ─────────────────────────────────────────────────────────────────

/**
 * Markers → segments. Mirrors `buildPath`'s interpolation exactly: the easing of
 * a segment comes from the marker at its *end* (`next.trans`/`next.ease`), which
 * is the BounceX convention and is easy to get backwards.
 *
 * Zero-length and negative-length segments are dropped; duplicate frame keys do
 * occur in hand-authored files.
 */
export function buildSegments(sortedMarkers: Marker[]): Segment[] {
  const segments: Segment[] = []
  for (let i = 0; i < sortedMarkers.length - 1; i++) {
    const cur = sortedMarkers[i]
    const next = sortedMarkers[i + 1]
    if (next.frame <= cur.frame) continue
    segments.push({
      tStart: frameToMs(cur.frame),
      tEnd: frameToMs(next.frame),
      from: cur.depth,
      to: next.depth,
      trans: next.trans,
      ease: next.ease,
    })
  }
  return segments
}

/**
 * Depth at an arbitrary time, by interpolating the segment that contains it.
 * Used for the single "catch up to here" move after a seek, and for the resting
 * position while paused.
 *
 * Callers that already hold the engine's per-frame `Float32Array` should sample
 * that instead — this exists for code paths (settings preview, seek) that only
 * have the plan.
 */
export function depthAt(segments: Segment[], tMs: number): number {
  if (segments.length === 0) return 0
  if (tMs <= segments[0].tStart) return segments[0].from
  const last = segments[segments.length - 1]
  if (tMs >= last.tEnd) return last.to

  // Binary search for the containing segment.
  let lo = 0
  let hi = segments.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (segments[mid].tEnd <= tMs) lo = mid + 1
    else hi = mid
  }
  const seg = segments[lo]
  const span = seg.tEnd - seg.tStart
  if (span <= 0) return seg.to
  const t = (tMs - seg.tStart) / span
  return seg.from + (seg.to - seg.from) * godotEase(t, seg.trans, seg.ease)
}

// ── Linearisation ────────────────────────────────────────────────────────────

/**
 * Worst-case distance between the true eased curve and its `n`-piece linear
 * approximation, in normalised units (so 1.0 = the segment's full depth
 * travel).
 *
 * Measured rather than modelled. A closed-form estimate is tempting — smooth
 * curves converge with 1/n² — but Expo and Elastic don't behave anything like
 * that, and underestimating here silently drives the device along a straight
 * line where the path says "slam".
 */
function pieceweiseError(trans: number, ease: number, n: number): number {
  const SAMPLES = 8
  let worst = 0
  for (let piece = 0; piece < n; piece++) {
    const t0 = piece / n
    const t1 = (piece + 1) / n
    const e0 = godotEase(t0, trans, ease)
    const e1 = godotEase(t1, trans, ease)
    for (let i = 1; i < SAMPLES; i++) {
      const u = i / SAMPLES
      const approx = e0 + (e1 - e0) * u
      const exact = godotEase(t0 + (t1 - t0) * u, trans, ease)
      worst = Math.max(worst, Math.abs(approx - exact))
    }
  }
  return worst
}

/**
 * Memoised per (trans, ease): a lazily grown table of normalised error by piece
 * count. A whole track only ever uses a handful of easing pairs, so this fills
 * once and then every segment lookup is an array index.
 */
const errorTables = new Map<number, number[]>()
function errorFor(trans: number, ease: number, n: number): number {
  const key = trans * 100 + ease
  let table = errorTables.get(key)
  if (!table) {
    table = []
    errorTables.set(key, table)
  }
  let v = table[n]
  if (v === undefined) {
    v = pieceweiseError(trans, ease, n)
    table[n] = v
  }
  return v
}

/**
 * How many linear pieces a segment needs.
 *
 * The error is a fraction of the *parameter* space, so it scales with the
 * segment's depth travel: a violently eased curve that only moves 0.01 in depth
 * is physically indistinguishable from a straight line and needs no
 * subdivision. Search upward from the duration floor and stop at the first
 * piece count that lands under tolerance, or at the device's command ceiling —
 * whichever comes first.
 */
function stepsFor(seg: Segment, opts: LinearizeOptions): number {
  const dur = seg.tEnd - seg.tStart
  const travel = Math.abs(seg.to - seg.from)
  const maxByDuration = Math.max(1, Math.floor(dur / opts.minCmdMs))
  const minByDuration = Math.max(1, Math.ceil(dur / opts.maxCmdMs))
  const hi = Math.max(minByDuration, maxByDuration)

  if (travel === 0) return minByDuration

  for (let n = minByDuration; n < hi; n++) {
    if (errorFor(seg.trans, seg.ease, n) * travel <= opts.tolerance) return n
  }
  return hi
}

/**
 * Segments → issuable linear moves.
 *
 * Two passes. The first subdivides each segment; the second enforces
 * `minCmdMs` *across* segment boundaries, because a dense passage of markers
 * (a 117 BPM track can put them ~30 ms apart) would otherwise emit a command
 * storm no transport survives. Merging keeps the *last* position of the merged
 * run, so stroke endpoints — the part you actually feel — are preserved and
 * only the intermediate detail is dropped.
 */
export function linearize(
  segments: Segment[],
  opts: LinearizeOptions = DEFAULT_LINEARIZE,
): StrokeCmd[] {
  const raw: StrokeCmd[] = []

  for (const seg of segments) {
    const dur = seg.tEnd - seg.tStart
    if (dur <= 0) continue
    const steps = stepsFor(seg, opts)
    const delta = seg.to - seg.from
    const stepDur = dur / steps
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      raw.push({
        t: seg.tStart + (s - 1) * stepDur,
        pos: seg.from + delta * godotEase(t, seg.trans, seg.ease),
        dur: stepDur,
      })
    }
  }

  if (raw.length === 0) return raw

  const out: StrokeCmd[] = []
  let pending: StrokeCmd | null = null
  for (const cmd of raw) {
    if (!pending) {
      pending = { ...cmd }
      continue
    }
    // `cmd.t - pending.t` rather than summing durations: gaps between segments
    // are real time the device spends holding still, and count toward the floor.
    const span = cmd.t - pending.t
    if (span < opts.minCmdMs) {
      // Absorb: keep the run's start time, adopt the newest target.
      pending.pos = cmd.pos
      pending.dur = cmd.t + cmd.dur - pending.t
      continue
    }
    pending.dur = Math.min(pending.dur, span)
    out.push(pending)
    pending = { ...cmd }
  }
  if (pending) out.push(pending)

  return out
}

/** Convenience: markers straight through to a rate-limited command list. */
export function buildStrokePlan(
  sortedMarkers: Marker[],
  opts: LinearizeOptions = DEFAULT_LINEARIZE,
): { segments: Segment[]; commands: StrokeCmd[] } {
  const segments = buildSegments(sortedMarkers)
  return { segments, commands: linearize(segments, opts) }
}

/**
 * Index of the first command at or after `tMs`, i.e. where playback resumes
 * after a seek. Binary search — this runs on every scrub.
 */
export function seekIndex(commands: StrokeCmd[], tMs: number): number {
  let lo = 0
  let hi = commands.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (commands[mid].t < tMs) lo = mid + 1
    else hi = mid
  }
  return lo
}
