/**
 * The middle layer of the bench chain, written down.
 *
 * The machine bench test (`BX-Studio/docs/plans/machine-bench-test.md`) films a
 * burnt-in timecode card and the rail in one frame, so two of the three layers
 * are already observable: the authored `.bx` on disk, and the carriage the
 * camera sees. **The layer between them is what the fork actually commanded, and
 * until this file existed nothing recorded it at all** — `lib/device/` has no
 * logging of any kind and `StrokeDriver.stats` is four running counters that
 * nothing reads.
 *
 * That gap is not cosmetic, and it is the reason this is part of the instrument
 * rather than an improvement to it. A tooth that comes back rounded on the rail
 * is ambiguous between a machine that could not serve it and a merge that never
 * asked for it, and those two have opposite consequences for every rate table in
 * the repo. With the command stream recorded the ambiguity disappears: either
 * the move was issued and the rail did not follow it, or it was never issued.
 *
 * Three design points that are not free choices.
 *
 * **Entries are keyed to VIDEO FRAME, not to seconds**, because the card is
 * numbered in frames and the whole point is that a row here can be read against
 * a still. `frame` is derived from the same `videoMs` the driver was ticked with,
 * so it is the fork's idea of where the video was, which is what we want to
 * compare against the burnt-in number rather than a second measurement of it.
 *
 * **The header carries `minCmdMs`.** A run whose log does not name its own merge
 * threshold is not readable afterwards: the bench runs segments 4, 5 and 7 twice,
 * at 100 and at 20, and two logs that do not say which is which are one wasted
 * session. `DEFAULT_LINEARIZE.minCmdMs` is 100 and a frame at 60 fps is 16.7 ms,
 * so at the default every single-frame pair in the path is coalesced by us before
 * the bridge is involved.
 *
 * **Nothing here can tell you anything about `k`.** It is a record of what was
 * asked for, and `k` is a property of the easing curve. Reading a recorder log as
 * evidence about the rate ceiling puts a fork-side number where an analytic one
 * belongs, which is the named failure in the plan doc.
 */

import { FPS } from '@/lib/player/constants'
import type { FitOptions } from './plan'

/**
 * Why a move was issued. `anchor` is the post-seek correction and `retract` the
 * slow withdrawal a track swap forces; neither is a path command.
 */
export type BenchKind = 'cmd' | 'anchor' | 'retract'

export type BenchEntry = {
  /** Video frame the move was issued at, from the `videoMs` the driver was ticked with. */
  frame: number
  /** Video time the move was issued at, ms. `frame` is this rounded to the grid. */
  videoMs: number
  /** The planned `StrokeCmd.t` this came from, ms, or null for an anchor. */
  cmdMs: number | null
  /** Position actually sent, after range/invert mapping. */
  pos: number
  /** Duration actually sent, ms, after the lateness subtraction and the floor. */
  dur: number
  kind: BenchKind
  /**
   * How many planned commands were collapsed into this one because they were all
   * already due. Zero on a healthy frame; anything else is the fork falling
   * behind, which looks identical on the rail to a machine that cannot keep up.
   */
  merged: number
  /** How late the issue was against the planned `t`, ms. */
  lateMs: number
  /** True when this frame re-anchored the index, i.e. a seek or a resume. */
  seek: boolean
}

export type BenchHeader = {
  startedAt: string
  /** The merge threshold the plan was built with. The one field a run is useless without. */
  minCmdMs: number
  leadMs: number
  offsetMs: number
  rangeMin: number
  rangeMax: number
  invert: boolean
  backend: string
  /** Commands in the loaded plan, so a truncated log is obvious. */
  planCommands: number
  /** Whatever the page knows about what is playing. Free-form on purpose. */
  label: string
  fps: number
  /**
   * The governor level and caps hash the loaded `.bx` was generated against,
   * from its `meta`. The grader refuses a run whose viewer, firmware and run
   * sheet hashes disagree. `'unknown'` when the `.bx` does not carry them.
   */
  governorLevel: string
  capsHash: string
  /**
   * The caps the plan was fitted to (`fitToMachine`), with the Sauce app range
   * they came from; travel is derived from that range and the stroke range.
   * Null when fitting was off. Moves a drop fit removed are counted in `merged`;
   * a shrink fit keeps every move and changes only `pos`.
   */
  fit: (FitOptions & { sauceMinPct: number; sauceMaxPct: number }) | null
}

/**
 * Bounded so a forgotten recorder cannot eat the tab. The bench path is 19,869
 * frames at 5:31 and its densest segment is 160 single-frame pairs, so a whole
 * run is a few thousand entries at the 20 ms threshold and well under this.
 * Hitting the cap means something other than a bench run is being recorded.
 */
export const MAX_ENTRIES = 200_000

export class BenchRecorder {
  private entries: BenchEntry[] = []
  private header: BenchHeader | null = null
  private overflowed = false

  isArmed(): boolean {
    return this.header !== null
  }

  arm(header: BenchHeader): void {
    this.header = header
    this.entries = []
    this.overflowed = false
  }

  disarm(): void {
    this.header = null
  }

  /** Called from the driver's send path. Allocation is one object per issued move. */
  record(entry: BenchEntry): void {
    if (!this.header) return
    if (this.entries.length >= MAX_ENTRIES) {
      this.overflowed = true
      return
    }
    this.entries.push(entry)
  }

  count(): number {
    return this.entries.length
  }

  didOverflow(): boolean {
    return this.overflowed
  }

  snapshot(): { header: BenchHeader | null; entries: BenchEntry[] } {
    return { header: this.header, entries: this.entries }
  }

  /**
   * CSV, because the thing that reads this is a person with a still of the card
   * beside them and then a one-line pandas read. The header goes in as `#`
   * comment lines rather than a second file: a run split across two files is a
   * run whose threshold can be lost, which is the failure this exists to stop.
   */
  toCsv(): string {
    const h = this.header
    const lines: string[] = []
    lines.push('# bx viewer fork, bench command log')
    lines.push('# what the fork COMMANDED. Not evidence about k; see lib/device/bench.ts.')
    if (h) {
      lines.push(`# startedAt=${h.startedAt}`)
      lines.push(`# minCmdMs=${h.minCmdMs}  leadMs=${h.leadMs}  offsetMs=${h.offsetMs}`)
      lines.push(`# governorLevel=${h.governorLevel}  capsHash=${h.capsHash}`)
      lines.push(
        h.fit
          ? `# fit=${h.fit.mode}  maxSpeed=${h.fit.maxSpeed}  maxAccel=${h.fit.maxAccel}  sauceMinPct=${h.fit.sauceMinPct}  sauceMaxPct=${h.fit.sauceMaxPct}  travelSteps=${Math.round(h.fit.travelSteps)}`
          : '# fit=off',
      )
      lines.push(`# rangeMin=${h.rangeMin}  rangeMax=${h.rangeMax}  invert=${h.invert}`)
      lines.push(`# backend=${h.backend}  planCommands=${h.planCommands}  fps=${h.fps}`)
      lines.push(`# label=${h.label}`)
    } else {
      lines.push('# NO HEADER: the recorder was never armed, so minCmdMs is unknown and')
      lines.push('# this log cannot be read. Discard it and re-run.')
    }
    if (this.overflowed) {
      lines.push(`# TRUNCATED at ${MAX_ENTRIES} entries.`)
    }
    lines.push('frame,videoMs,cmdMs,pos,dur,kind,merged,lateMs,seek')
    for (const e of this.entries) {
      lines.push(
        [
          e.frame,
          e.videoMs.toFixed(1),
          e.cmdMs === null ? '' : e.cmdMs.toFixed(1),
          e.pos.toFixed(5),
          e.dur.toFixed(1),
          e.kind,
          e.merged,
          e.lateMs.toFixed(1),
          e.seek ? 1 : 0,
        ].join(','),
      )
    }
    return lines.join('\n') + '\n'
  }
}

/** The frame the card would be showing at `videoMs`. */
export function frameOf(videoMs: number, fps = FPS): number {
  return Math.round((videoMs / 1000) * fps)
}
