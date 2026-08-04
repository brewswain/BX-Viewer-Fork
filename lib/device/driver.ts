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
 *  - **Seeking.** Video time jumps. Re-index by binary search and issue one
 *    catch-up move to wherever the path says we should be, rather than
 *    replaying the commands we skipped.
 *  - **Falling behind.** A backgrounded tab, a stalled network read, or a slow
 *    transport can leave several commands due at once. Replaying them all would
 *    put the device further behind with every frame; only the newest is sent,
 *    with its duration shortened by however late we are.
 *  - **Pausing.** The device has to be explicitly stopped — otherwise it
 *    finishes its last move and sits there, which is fine, or keeps looping,
 *    which is not. Hence the one guaranteed inactive frame described above.
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

/** Never ask for a move shorter than this — below it, hardware just slams. */
const MIN_MOVE_MS = 20

/**
 * A post-seek correction is skipped if the next real command is closer than
 * this, since the correction would be cancelled before it completed.
 */
const MIN_ANCHOR_MS = 80

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
  /** How long the catch-up move after a seek is given to complete. */
  seekSettleMs: number
  mapping: OutputMapping
}

export const DEFAULT_DRIVER_OPTIONS: DriverOptions = {
  leadMs: 0,
  offsetMs: 0,
  seekThresholdMs: 250,
  seekSettleMs: 250,
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

  /** Diagnostics for the UI — cheap counters, no allocation on the hot path. */
  readonly stats = { sent: 0, skipped: 0, seeks: 0, lastPos: 0, lastDur: 0 }

  setBackend(backend: DeviceBackend | null): void {
    if (this.backend === backend) return
    this.backend?.stop()
    this.backend = backend
    this.stopped = true
    this.lastPlanMs = null
  }

  setPlan(plan: StrokePlan): void {
    this.plan = plan
    this.idx = 0
    this.lastPlanMs = null
  }

  setOptions(partial: Partial<DriverOptions>): void {
    this.opts = { ...this.opts, ...partial }
  }

  getOptions(): DriverOptions {
    return this.opts
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
    if (!this.stopped) {
      this.backend?.stop()
      this.stopped = true
    }
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
   */
  tick(videoMs: number, active: boolean): void {
    if (!this.running || !this.backend) return

    if (!active) {
      // Hold position. `stopped` makes this a no-op after the first frame.
      if (!this.stopped) {
        this.backend.stop()
        this.stopped = true
        this.lastPlanMs = null
      }
      return
    }

    const cmds = this.plan.commands
    if (cmds.length === 0) return

    const planMs = videoMs - this.opts.offsetMs + this.opts.leadMs

    // A jump — or the first frame after resuming — re-anchors the index rather
    // than replaying the commands in between.
    const jumped =
      this.lastPlanMs === null ||
      Math.abs(planMs - this.lastPlanMs) > this.opts.seekThresholdMs
    if (jumped) {
      if (this.lastPlanMs !== null) this.stats.seeks++
      this.idx = seekIndex(cmds, planMs)
    }
    this.lastPlanMs = planMs
    this.stopped = false

    // Collapse everything already due into a single move. `dueIdx` ends on the
    // last command whose start time has passed.
    let dueIdx = -1
    while (this.idx < cmds.length && cmds[this.idx].t <= planMs) {
      if (dueIdx >= 0) this.stats.skipped++
      dueIdx = this.idx
      this.idx++
    }

    if (dueIdx >= 0) {
      const cmd = cmds[dueIdx]
      // Shorten by however late we are, so the move still lands on schedule.
      // The floor keeps a badly-late command from becoming a slam.
      const late = planMs - cmd.t
      this.send(cmd.pos, Math.max(MIN_MOVE_MS, cmd.dur - late))
      return
    }

    if (!jumped) return

    // Landed mid-segment with nothing due: glide to where the path says we are.
    // Only worth doing if there's room before the next command — otherwise the
    // move would be cancelled almost immediately, and cramming it into the gap
    // would turn a cosmetic correction into a slam.
    const next = cmds[this.idx]
    const budget = next ? next.t - planMs : this.opts.seekSettleMs
    if (budget < MIN_ANCHOR_MS) return
    this.send(
      depthAt(this.plan.segments, planMs),
      Math.min(this.opts.seekSettleMs, budget),
    )
  }

  private send(depth: number, durMs: number): void {
    const pos = mapDepth(depth, this.opts.mapping)
    this.stats.sent++
    this.stats.lastPos = pos
    this.stats.lastDur = durMs
    this.backend?.move(pos, durMs)
  }
}
