/**
 * The scheduler: turns "the video is at time T" into device moves.
 *
 * Driven from the engine's `onFrame`, which fires every rAF (~144 Hz) while the
 * video is advancing, seeking or buffering — see `docs/theater-mode-jitter.md`.
 * So `tick` is written to be cheap and idempotent: it does an O(1) comparison
 * and returns, and only touches the transport when a planned command actually
 * comes due.
 *
 * It does **not** keep firing while paused. The engine's loop halts once nothing
 * is moving, and the machine is stopped by the single frame the `pause` / `ended`
 * / `seeking` events schedule on the way in — which is enough because the first
 * inactive `tick` stops the transport and every one after it is a no-op. Any new
 * state that means "no longer advancing" has to reach `tick` the same way: if it
 * doesn't fire one of those video events, it must call the engine's
 * `scheduleFrame()` itself, or the device will hold its last move.
 *
 * The three cases that make this non-trivial:
 *
 *  - **Seeking.** Video time jumps (so does every resume and the first frame).
 *    Re-index by binary search and issue one catch-up move rather than
 *    replaying the commands we skipped. The catch-up is a safety move, not a
 *    sync move: it never travels faster than `SAFE_FULL_RAIL_MS` allows, so
 *    it glides to the first upcoming point of the path it can reach in time at
 *    that speed and the path carries on from there exactly as written. A
 *    catch-up that aimed at "where the path is now" would be overtaken by the
 *    next command and become the very ram the cap exists to stop.
 *  - **Falling behind.** A backgrounded tab, a stalled network read, or a slow
 *    transport can leave several commands due at once. Replaying them all would
 *    put the device further behind with every frame; only the newest is sent,
 *    with its duration shortened by however late we are.
 *  - **Pausing.** The device has to be explicitly stopped — otherwise it
 *    finishes its last move and sits there, which is fine, or keeps looping,
 *    which is not. Hence the one guaranteed inactive frame described above.
 *
 * And one safety rule on top of all three:
 *
 *  - **Swapping tracks.** Two difficulties of one video can be at opposite ends
 *    of the rail at the same instant, and re-anchoring onto the new one would
 *    drive the machine there in a quarter of a second. So `swapPlan` never
 *    re-anchors: the old track keeps playing until the machine is fully out,
 *    the machine then holds out, and the new track takes over only once it is
 *    out too, so the handover happens at depth ~0 on both sides. If the old
 *    track does not come out in time, or the swap lands while paused or across
 *    a seek, the machine retracts on its own at a deliberately slow speed.
 */

import {
  depthAt,
  seekIndex,
  type Segment,
  type StrokeCmd,
} from './plan'
import {
  DEFAULT_MAPPING,
  mapDepth,
  type DeviceBackend,
  type OutputMapping,
} from './types'
import { frameOf, type BenchKind, type BenchRecorder } from './bench'

/** Never ask for a move shorter than this — below it, hardware just slams. */
const MIN_MOVE_MS = 20

/**
 * The speed cap on every move the driver makes up rather than reads off the
 * path (a catch-up or a swap retract): wall ms per full rail of raw depth.
 * 1500 is about 0.33 m/s on a 500 mm rail, and slower still on a narrowed
 * range. Path commands are never capped; their speed is the file's design.
 */
export const SAFE_FULL_RAIL_MS = 1500

/** Raw `.bx` depth at or below which the machine counts as fully withdrawn. */
export const SWAP_OUT_DEPTH = 0.1

/**
 * How long (media ms) the old track gets to come out by itself before the
 * machine retracts on its own. Long enough to cover a slow stroke, short
 * enough that a park or a mid-rail section does not hold the swap hostage.
 */
export const SWAP_LEAVE_MAX_MS = 5000

/**
 * `leave`: the old plan is still playing, waiting for it to come out.
 * `retract`: the machine is withdrawing on its own.
 * `out`: the new plan is installed and the machine holds until it comes out.
 */
export type SwapPhase = 'leave' | 'retract' | 'out'

export type StrokePlan = {
  segments: Segment[]
  commands: StrokeCmd[]
}

export const EMPTY_PLAN: StrokePlan = { segments: [], commands: [] }

export type DriverOptions = {
  /**
   * Issue each move this many ms early, to cover transport + device latency.
   * Positive values make the device lead the video.
   */
  leadMs: number
  /**
   * Extra shift applied to the whole plan, for users whose rig is
   * mechanically ahead of or behind the picture. Positive = device later.
   */
  offsetMs: number
  /**
   * A jump larger than this is treated as a seek rather than as drift.
   * Comfortably above one frame at 60 fps (16.7 ms) and below the shortest
   * skip anyone performs by hand.
   */
  seekThresholdMs: number
  mapping: OutputMapping
}

export const DEFAULT_DRIVER_OPTIONS: DriverOptions = {
  leadMs: 0,
  offsetMs: 0,
  seekThresholdMs: 250,
  mapping: DEFAULT_MAPPING,
}

export class StrokeDriver {
  private plan: StrokePlan = EMPTY_PLAN
  private opts: DriverOptions = { ...DEFAULT_DRIVER_OPTIONS }
  private backend: DeviceBackend | null = null

  /** Index of the next command to issue. */
  private idx = 0
  /** Plan-time of the previous tick, for seek detection. `null` = no history. */
  private lastPlanMs: number | null = null
  private running = false
  /** Suppresses repeat `stop()` calls while sitting paused. */
  private stopped = true

  /**
   * Diagnostics for the UI — cheap counters, no allocation on the hot path.
   *
   * `lastLateMs` and `lastMerged` joined for the bench HUD: a command storm and
   * a fall-behind are the two things that look, on the rail, exactly like a
   * machine that cannot keep up, and neither is visible in the other four.
   */
  readonly stats = {
    sent: 0,
    skipped: 0,
    seeks: 0,
    lastPos: 0,
    lastDur: 0,
    lastLateMs: 0,
    lastMerged: 0,
  }

  /**
   * Set while a bench run is being recorded; null the rest of the time, which is
   * the normal case and costs one null check per issued move.
   */
  private recorder: BenchRecorder | null = null
  /** Whether the frame currently being handled re-anchored. Read by `send`. */
  private seekFrame = false

  /**
   * Where the machine can be, as a raw-depth range: a point once a move has
   * been commanded, widened back to the move's whole span by a stop, since a
   * stop lands it somewhere in between. Starts as the whole rail because an
   * unknown position has to be assumed the worst one; the range only ever
   * sizes the safety moves, and a wider one only makes them slower.
   */
  private posLo = 0
  private posHi = 1
  /** The range the current move started from, for widening on a stop. */
  private fromLo = 0
  private fromHi = 1
  /** Plan time the last commanded move completes at. */
  private moveEndMs = 0

  /** Track-swap gate; null when no swap is in progress. See the header. */
  private swap: SwapPhase | null = null
  /** The incoming plan, held until the machine is out. Only set in `leave`/`retract`. */
  private pending: StrokePlan | null = null
  /** Plan time `leave` started waiting at; null until its first active frame. */
  private swapSince: number | null = null
  /** Told about each swap transition, for the device log. */
  onSwap: ((phase: SwapPhase | 'joined') => void) | null = null

  setBackend(backend: DeviceBackend | null): void {
    if (this.backend === backend) return
    this.backend?.stop()
    this.backend = backend
    this.stopped = true
    this.lastPlanMs = null
    this.posLo = this.fromLo = 0
    this.posHi = this.fromHi = 1
  }

  /** Stop the machine wherever it is, which may be anywhere along its move. */
  private stopBackend(): void {
    this.backend?.stop()
    this.stopped = true
    this.settle(this.lastPlanMs)
  }

  /**
   * Account for a move cut short at plan time `atMs` (null: unknown), which
   * leaves the machine anywhere along it. Called on a stop, on a plan
   * replaced mid-move, and on a jump, which can land mid-move without a stop
   * (a tab coming back, a scrub the caller never reported as inactive).
   */
  private settle(atMs: number | null): void {
    if (atMs !== null && atMs >= this.moveEndMs) return
    this.posLo = Math.min(this.posLo, this.fromLo)
    this.posHi = Math.max(this.posHi, this.fromHi)
  }

  /** Worst-case travel from wherever the machine may be to `depth`. */
  private reach(depth: number): number {
    return Math.max(Math.abs(depth - this.posLo), Math.abs(depth - this.posHi))
  }

  /**
   * Replace the plan immediately. For a rebuild of the same track (a
   * `minCmdMs` change) or for clearing it; a different track goes through
   * `swapPlan`. A rebuild that arrives mid-swap replaces whichever plan the
   * swap is holding rather than cutting the gate short.
   */
  setPlan(plan: StrokePlan): void {
    if (plan.commands.length === 0) this.cancelSwap()
    else if (this.swap === 'leave' || this.swap === 'retract') {
      this.pending = plan
      return
    }
    this.plan = plan
    this.idx = 0
    this.settle(this.lastPlanMs)
    this.lastPlanMs = null
  }

  /**
   * Hand over a different track without ever re-anchoring onto it: see the
   * header. With no track playing yet, or a machine that has not moved, there
   * is nothing to withdraw from and the plan is installed directly.
   */
  swapPlan(plan: StrokePlan): void {
    if (
      plan.commands.length === 0 ||
      (this.swap === null &&
        (this.plan.commands.length === 0 || this.stats.sent === 0))
    ) {
      this.setPlan(plan)
      return
    }
    if (this.swap === 'out') {
      // Already holding out for a new track; this one simply replaces it.
      this.plan = plan
      this.idx = 0
      return
    }
    this.pending = plan
    if (this.swap === null) {
      this.swap = 'leave'
      this.swapSince = null
      this.onSwap?.('leave')
    }
  }

  /** The swap phase in progress, or null. */
  swapPhase(): SwapPhase | null {
    return this.swap
  }

  private cancelSwap(): void {
    this.swap = null
    this.pending = null
    this.swapSince = null
  }

  setOptions(partial: Partial<DriverOptions>): void {
    this.opts = { ...this.opts, ...partial }
  }

  getOptions(): DriverOptions {
    return this.opts
  }

  /**
   * Attach or detach the bench recorder. Passing null is the resting state, so
   * an ordinary playthrough pays one null check per issued move and nothing else.
   */
  setRecorder(recorder: BenchRecorder | null): void {
    this.recorder = recorder
  }

  /**
   * Enable/disable output. Disabling stops the device immediately; the plan and
   * position are kept so re-enabling mid-playback resumes in the right place.
   */
  setRunning(running: boolean): void {
    if (this.running === running) return
    this.running = running
    if (!running) this.halt()
    else this.lastPlanMs = null
  }

  isRunning(): boolean {
    return this.running
  }

  /** Stop the device and forget where we were, without discarding the plan. */
  halt(): void {
    if (!this.stopped) this.stopBackend()
    this.lastPlanMs = null
  }

  /**
   * Called once per rendered frame.
   *
   * @param videoMs  `video.currentTime * 1000`
   * @param active   whether the video is genuinely advancing — i.e. playing,
   *                 not seeking, not stalled. The caller owns this because the
   *                 engine's `paused` state lies during a scrub: it pauses on
   *                 `seeking` and resumes on `seeked`.
   * @param rate     `video.playbackRate`. The plan is entirely in media time,
   *                 but a device move is given a *wall-clock* duration, so at
   *                 2× a 400 ms segment has to be commanded as a 200 ms move or
   *                 the machine falls a stroke behind per stroke. Everything
   *                 that crosses that boundary is divided by this.
   */
  tick(videoMs: number, active: boolean, rate = 1): void {
    if (!this.running || !this.backend) return
    // A rate of 0 is not a thing a media element reports while advancing, but
    // it would divide the whole schedule into infinities if it ever were.
    const speed = Number.isFinite(rate) && rate > 0 ? rate : 1

    if (!active) {
      // Hold position. `stopped` makes this a no-op after the first frame.
      if (!this.stopped) {
        this.stopBackend()
        this.lastPlanMs = null
      }
      return
    }

    const cmds = this.plan.commands
    if (cmds.length === 0) return

    const planMs = videoMs - this.opts.offsetMs + this.opts.leadMs

    // A jump — or the first frame after resuming — re-anchors the index rather
    // than replaying the commands in between.
    // The threshold is a wall-clock idea — "more than a person could have
    // watched between two frames" — so it scales with the rate too, or 4×
    // playback on a slow frame would read as a seek and re-anchor for nothing.
    const jumped =
      this.lastPlanMs === null ||
      Math.abs(planMs - this.lastPlanMs) > this.opts.seekThresholdMs * speed
    // A jump straight after a stop was already settled by the stop.
    if (jumped && this.lastPlanMs !== null) {
      this.stats.seeks++
      this.settle(this.lastPlanMs)
    }
    this.lastPlanMs = planMs
    this.stopped = false
    this.seekFrame = jumped

    if (this.swap !== null && this.tickSwap(planMs, jumped, speed, videoMs)) {
      return
    }
    if (jumped) {
      this.catchUp(planMs, speed, videoMs)
      return
    }

    // Collapse everything already due into a single move. `dueIdx` ends on the
    // last command whose start time has passed.
    let dueIdx = -1
    let merged = 0
    while (this.idx < cmds.length && cmds[this.idx].t <= planMs) {
      if (dueIdx >= 0) {
        this.stats.skipped++
        merged++
      }
      dueIdx = this.idx
      this.idx++
    }

    if (dueIdx >= 0) {
      const cmd = cmds[dueIdx]
      // Shorten by however late we are, so the move still lands on schedule.
      // The floor keeps a badly-late command from becoming a slam.
      const late = planMs - cmd.t
      this.moveEndMs = cmd.t + cmd.dur
      this.send(cmd.pos, Math.max(MIN_MOVE_MS, (cmd.dur - late) / speed), {
        videoMs,
        cmdMs: cmd.t,
        kind: 'cmd',
        merged: merged + (cmd.merged ?? 0),
        lateMs: late,
      })
    }
  }

  /**
   * The capped catch-up after a jump: see the header. Walks forward from the
   * command in progress to the first command whose END the machine can reach
   * in the time left before it, at no more than `SAFE_FULL_RAIL_MS`, and
   * glides there arriving exactly on schedule. Every command after it then
   * starts from where the path expects the machine to be. Each candidate end
   * is a stroke's turnaround or a point along it, so on any path that moves
   * this lands within a stroke or two.
   */
  private catchUp(planMs: number, speed: number, videoMs: number): void {
    const cmds = this.plan.commands
    let i = seekIndex(cmds, planMs)
    if (i > 0 && cmds[i - 1].t + cmds[i - 1].dur > planMs) i--
    for (; i < cmds.length; i++) {
      const c = cmds[i]
      const end = c.t + c.dur
      const wall = (end - planMs) / speed
      if (wall < MIN_MOVE_MS || wall < this.reach(c.pos) * SAFE_FULL_RAIL_MS) {
        continue
      }
      this.idx = i + 1
      this.moveEndMs = end
      this.send(c.pos, wall, {
        videoMs,
        cmdMs: c.t,
        kind: 'anchor',
        merged: 0,
        lateMs: 0,
      })
      return
    }
    // Past the end of the path, or too close to it: settle on its last depth.
    this.idx = cmds.length
    const last = cmds[cmds.length - 1].pos
    const dur = Math.max(MIN_MOVE_MS, this.reach(last) * SAFE_FULL_RAIL_MS)
    this.moveEndMs = planMs + dur * speed
    this.send(last, dur, {
      videoMs,
      cmdMs: null,
      kind: 'anchor',
      merged: 0,
      lateMs: 0,
    })
  }

  /**
   * One frame of the swap gate. Returns true when it has handled the frame and
   * the normal scheduler must not run; false in `leave` while the old track is
   * still playing out, which is the normal scheduler's job.
   */
  private tickSwap(
    planMs: number,
    jumped: boolean,
    speed: number,
    videoMs: number,
  ): boolean {
    if (this.swap === 'leave') {
      // A resume or a seek means the old track's position is no longer where
      // the machine is, so it is not trusted to bring the machine out.
      if (jumped) return this.startRetract(planMs, speed, videoMs)
      if (this.posHi <= SWAP_OUT_DEPTH && planMs >= this.moveEndMs) {
        return this.enterOut()
      }
      if (this.swapSince === null) this.swapSince = planMs
      if (planMs - this.swapSince > SWAP_LEAVE_MAX_MS) {
        return this.startRetract(planMs, speed, videoMs)
      }
      return false
    }

    if (this.swap === 'retract') {
      // A pause stops the retract wherever it got to, and the stop widened the
      // position back to the retract's whole span, so this resends it whole.
      if (jumped) return this.startRetract(planMs, speed, videoMs)
      if (planMs >= this.moveEndMs) return this.enterOut()
      return true
    }

    // `out`: hold until the new track is out as well, then let the capped
    // catch-up join it next frame, from a machine that is already out.
    if (depthAt(this.plan.segments, planMs) <= SWAP_OUT_DEPTH) {
      this.swap = null
      this.lastPlanMs = null
      this.onSwap?.('joined')
    }
    return true
  }

  private startRetract(planMs: number, speed: number, videoMs: number): true {
    this.swap = 'retract'
    const dur = Math.max(MIN_MOVE_MS, this.reach(0) * SAFE_FULL_RAIL_MS)
    this.moveEndMs = planMs + dur * speed
    this.send(0, dur, {
      videoMs,
      cmdMs: null,
      kind: 'retract',
      merged: 0,
      lateMs: 0,
    })
    this.onSwap?.('retract')
    return true
  }

  private enterOut(): true {
    if (this.pending) {
      this.plan = this.pending
      this.idx = 0
    }
    this.pending = null
    this.swap = 'out'
    this.onSwap?.('out')
    return true
  }

  /**
   * `meta` is only read by the bench recorder, and it is a plain object literal
   * built at each of the two call sites rather than fields on the driver,
   * because the two sites disagree about every one of them and threading it
   * through state is how an anchor ends up logged as a path command.
   */
  private send(
    depth: number,
    durMs: number,
    meta: {
      videoMs: number
      cmdMs: number | null
      kind: BenchKind
      merged: number
      lateMs: number
    },
  ): void {
    const pos = mapDepth(depth, this.opts.mapping)
    this.fromLo = this.posLo
    this.fromHi = this.posHi
    this.posLo = this.posHi = depth
    this.stats.sent++
    this.stats.lastPos = pos
    this.stats.lastDur = durMs
    this.stats.lastLateMs = meta.lateMs
    this.stats.lastMerged = meta.merged
    this.recorder?.record({
      frame: frameOf(meta.videoMs),
      videoMs: meta.videoMs,
      cmdMs: meta.cmdMs,
      pos,
      dur: durMs,
      kind: meta.kind,
      merged: meta.merged,
      lateMs: meta.lateMs,
      seek: this.seekFrame,
    })
    this.backend?.move(pos, durMs)
  }
}
