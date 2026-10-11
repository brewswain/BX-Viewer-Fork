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
  /** Raw moves folded into this one by the `minCmdMs` pass (bench log only). */
  merged?: number
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
 *
 * Except at a turning point. Keeping the last position of a run that reverses
 * inside the window throws the peak away: a one-frame snap followed by its
 * return collapsed to the return target, and the 2026-10-10 bench sent a
 * constant 0 through every snap run. So a reversal emits the peak and delays
 * the return to the floor, as long as the return still has time to land on
 * schedule; when it does not (cycles shorter than two floors), the peak is
 * kept and the return target dropped, so the stroke halves in rate rather than
 * vanishing. The return is only ever delayed within its own span, so no lag
 * accumulates.
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
  // Where the device is when `pending` starts: the last emitted target.
  let base = segments[0].from
  const emit = (c: StrokeCmd) => {
    out.push(c)
    base = c.pos
  }
  for (const cmd of raw) {
    if (!pending) {
      pending = { ...cmd, merged: 0 }
      continue
    }
    // `cmd.t - pending.t` rather than summing durations: gaps between segments
    // are real time the device spends holding still, and count toward the floor.
    const span = cmd.t - pending.t
    if (span >= opts.minCmdMs) {
      pending.dur = Math.min(pending.dur, span)
      emit(pending)
      pending = { ...cmd, merged: 0 }
      continue
    }
    const dir = Math.sign(pending.pos - base)
    if (dir !== 0 && Math.sign(cmd.pos - pending.pos) === -dir) {
      const end: number = cmd.t + cmd.dur
      const backT: number = pending.t + opts.minCmdMs
      if (backT < end) {
        pending.dur = Math.min(pending.dur, opts.minCmdMs)
        emit(pending)
        pending = { t: backT, pos: cmd.pos, dur: end - backT, merged: 0 }
      } else {
        pending.merged = (pending.merged ?? 0) + 1
      }
      continue
    }
    // Absorb: keep the run's start time, adopt the newest target.
    pending.pos = cmd.pos
    pending.dur = cmd.t + cmd.dur - pending.t
    pending.merged = (pending.merged ?? 0) + 1
  }
  if (pending) out.push(pending)

  return out
}

// ── Fit to machine ───────────────────────────────────────────────────────────

/** What the machine can do, in its own steps. */
export type FitOptions = {
  /** Steps/s. */
  maxSpeed: number
  /** Steps/s². */
  maxAccel: number
  /** Steps the whole 0..1 depth range spans after the stroke-range mapping. */
  travelSteps: number
  /**
   * What to do with a stroke the machine cannot make in time: `shrink` it to
   * the length it can make (keeps every stroke and the rhythm), or `drop` the
   * wiggle so the strokes around it stay full length (fewer, deeper strokes).
   */
  mode: FitMode
}

export type FitMode = 'shrink' | 'drop'

/**
 * Steps OSSM Sauce's homed range spans (homing's TOTAL RANGE on the bench unit,
 * 2026-10-10). The Sauce app's min/max range sliders are percents of this.
 */
export const SAUCE_HOMED_STEPS = 5800

/** Steps a Sauce app range of `minPct`..`maxPct` covers, each clamped to 0..100. */
export function sauceTravelSteps(minPct: number, maxPct: number): number {
  const lo = Math.min(100, Math.max(0, minPct))
  const hi = Math.min(100, Math.max(0, maxPct))
  return (SAUCE_HOMED_STEPS * Math.max(0, hi - lo)) / 100
}

export const DEFAULT_FIT: FitOptions = {
  maxSpeed: 20000,
  maxAccel: 500000,
  travelSteps: SAUCE_HOMED_STEPS,
  // 2026-10-10 live session: dropping wiggles read as far fewer strokes than
  // expected; keeping the rhythm with shallower strokes felt better.
  mode: 'shrink',
}

/**
 * Shortest time (ms) a trapezoidal move of `steps` takes from rest to rest.
 * Rest to rest is the conservative case: a turning point is a stop.
 */
export function minMoveMs(steps: number, maxSpeed: number, maxAccel: number): number {
  if (steps <= 0) return 0
  const s =
    steps < (maxSpeed * maxSpeed) / maxAccel
      ? 2 * Math.sqrt(steps / maxAccel)
      : steps / maxSpeed + maxSpeed / maxAccel
  return s * 1000
}

/** Longest trapezoidal move (steps) from rest to rest in `ms`; inverse of `minMoveMs`. */
export function maxMoveSteps(ms: number, maxSpeed: number, maxAccel: number): number {
  if (ms <= 0) return 0
  const s = ms / 1000
  return s <= (2 * maxSpeed) / maxAccel
    ? (maxAccel * s * s) / 4
    : maxSpeed * (s - maxSpeed / maxAccel)
}

/**
 * Endpoints of monotone runs, as command indices; -1 is the start. A hold (no
 * change) carries the previous direction, so it never makes a turn.
 */
function runEnds(cmds: StrokeCmd[], start: number): number[] {
  const pos = (i: number) => (i < 0 ? start : cmds[i].pos)
  const ends: number[] = [-1]
  let dir = 0
  for (let i = 0; i < cmds.length; i++) {
    const d = Math.sign(pos(i) - pos(i - 1))
    if (d !== 0 && dir !== 0 && d !== dir) ends.push(i - 1)
    if (d !== 0) dir = d
  }
  if (ends[ends.length - 1] !== cmds.length - 1) ends.push(cmds.length - 1)
  return ends
}

/**
 * How far ahead (ms) the pass may look for a stroke it can make. Matches
 * `DEFAULT_LINEARIZE.maxCmdMs`, so a fitted stroke is never longer than the
 * longest move linearize would emit.
 */
const FIT_MAX_WINDOW_MS = 1000

/**
 * Make the plan something the machine can follow, per `fit.mode`.
 *
 * A device given a stroke it cannot finish in time does not skip it: OSSM Sauce
 * retargets mid-move, so in a fast passage strokes come out short and ragged
 * (2026-10-10 live session: about half of a fast script's moves were out of
 * reach at 15000 steps/s, 500000 steps/s²). A path the machine can follow
 * comes out unchanged in either mode. `start` is the depth before the first
 * command.
 */
export function fitToMachine(cmds: StrokeCmd[], start: number, fit: FitOptions): StrokeCmd[] {
  if (cmds.length < 2 || fit.travelSteps <= 0) return cmds
  return fit.mode === 'drop' ? dropToMachine(cmds, start, fit) : shrinkToMachine(cmds, start, fit)
}

/**
 * Shorten each stroke the machine cannot make in time to the length it can,
 * keeping every stroke and every arrival time, so the rhythm survives at the
 * cost of depth.
 *
 * A short stroke stops early on its own side, so the stroke back from it is
 * shorter too: a too-fast 0..1 zigzag settles at 0..x around the start, i.e.
 * shallower rather than recentred. The moves inside a stroke are rescaled onto
 * the shortened stroke, so their shape is kept. Sending the shortened stroke
 * beats letting Sauce retarget mid-move: the machine gets to stop and turn
 * where the plan says, instead of being yanked around at speed.
 */
function shrinkToMachine(cmds: StrokeCmd[], start: number, fit: FitOptions): StrokeCmd[] {
  const pos = (i: number) => (i < 0 ? start : cmds[i].pos)
  const arrive = (i: number) => cmds[i].t + cmds[i].dur
  const ends = runEnds(cmds, start)

  const out: StrokeCmd[] = []
  let at = start
  for (let e = 0; e < ends.length - 1; e++) {
    const k = ends[e]
    const c = ends[e + 1]
    const from = pos(k)
    const want = pos(c) - from
    const reach =
      maxMoveSteps(arrive(c) - cmds[k + 1].t, fit.maxSpeed, fit.maxAccel) / fit.travelSteps
    const gap = pos(c) - at
    const target = Math.abs(gap) <= reach ? pos(c) : at + Math.sign(gap) * reach
    if (want === 0 || (at === from && target === pos(c))) {
      for (let i = k + 1; i <= c; i++) out.push(cmds[i])
    } else {
      const scale = (target - at) / want
      for (let i = k + 1; i <= c; i++) out.push({ ...cmds[i], pos: at + (cmds[i].pos - from) * scale })
    }
    at = want === 0 ? at : target
  }
  return out
}

/**
 * Drop the wiggles the machine cannot make, keeping the strokes it can make at
 * full length: fewer strokes, at full depth.
 *
 * Works stroke by stroke, a stroke being the run of moves between two turning
 * points. When the stroke from the last kept turning point to the next one is
 * out of reach, the next turning point is dropped together with the one after
 * it, so the direction keeps alternating, and the stroke runs to the turning
 * point after that instead, over the combined time. Its target is the most
 * extreme of the same-direction turning points it skipped over, when that is
 * reachable, so a big peak followed by smaller wiggles is not traded for the
 * wiggle. A stroke that dropping cannot help (a lone big jump, or nothing
 * reachable within `FIT_MAX_WINDOW_MS`) is left alone, as is any stroke that is
 * already reachable. Arrival times of every kept turning point are untouched.
 */
function dropToMachine(cmds: StrokeCmd[], start: number, fit: FitOptions): StrokeCmd[] {
  const pos = (i: number) => (i < 0 ? start : cmds[i].pos)
  const arrive = (i: number) => cmds[i].t + cmds[i].dur
  const ends = runEnds(cmds, start)

  const reachable = (from: number, to: number, ms: number) =>
    minMoveMs(Math.abs(to - from) * fit.travelSteps, fit.maxSpeed, fit.maxAccel) <= ms

  const out: StrokeCmd[] = []
  let at = start
  let e = 0
  while (e < ends.length - 1) {
    const k = ends[e]
    const c = ends[e + 1]
    const issue = cmds[k + 1].t
    let jump = 0
    let target = 0
    if (!reachable(at, pos(c), arrive(c) - issue)) {
      const sign = Math.sign(pos(c) - at)
      let extreme = pos(c)
      // Skipped same-direction turning points sit at ends[e+1], ends[e+3], ...
      for (let j = e + 3; j < ends.length; j += 2) {
        const cand = ends[j]
        const window = arrive(cand) - issue
        if (window > FIT_MAX_WINDOW_MS) break
        // The extreme is only worth it if it is reachable; otherwise settle for
        // the turning point that actually sits at this time.
        if (sign * (pos(cand) - extreme) >= 0) extreme = pos(cand)
        const pick = reachable(at, extreme, window)
          ? extreme
          : reachable(at, pos(cand), window)
            ? pos(cand)
            : null
        if (pick !== null) {
          jump = j
          target = pick
          break
        }
      }
    }
    if (jump) {
      const last = ends[jump]
      let merged = 0
      for (let i = k + 1; i <= last; i++) merged += 1 + (cmds[i].merged ?? 0)
      out.push({ t: issue, pos: target, dur: arrive(last) - issue, merged: merged - 1 })
      at = target
      e = jump
    } else {
      for (let i = k + 1; i <= c; i++) out.push(cmds[i])
      at = pos(c)
      e += 1
    }
  }
  return out
}

/** Convenience: markers straight through to a rate-limited command list. */
export function buildStrokePlan(
  sortedMarkers: Marker[],
  opts: LinearizeOptions = DEFAULT_LINEARIZE,
  fit?: FitOptions,
): { segments: Segment[]; commands: StrokeCmd[] } {
  const segments = buildSegments(sortedMarkers)
  const commands = linearize(segments, opts)
  if (!fit || segments.length === 0) return { segments, commands }
  return { segments, commands: fitToMachine(commands, segments[0].from, fit) }
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
