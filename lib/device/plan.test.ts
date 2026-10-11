/**
 * `bun test lib/device` — no test dependency, bun's runner is built in.
 *
 * These cover the stroke-planning maths, which is the part with no visible
 * failure mode: a wrong plan doesn't throw, it just drives the device out of
 * sync with the video.
 */

import { describe, expect, test } from 'bun:test'
import { godotEase } from '@/lib/player/bx'
import { FPS } from '@/lib/player/constants'
import type { Marker } from '@/lib/player/types'
import {
  buildSegments,
  buildStrokePlan,
  DEFAULT_FIT,
  DEFAULT_LINEARIZE,
  depthAt,
  fitToMachine,
  linearize,
  minMoveMs,
  seekIndex,
  type StrokeCmd,
} from './plan'

const m = (frame: number, depth: number, trans = 0, ease = 0): Marker => ({
  frame,
  depth,
  trans,
  ease,
})

/** Frame → ms at the player's fixed 60 fps. */
const ms = (frame: number) => (frame / FPS) * 1000

describe('buildSegments', () => {
  test('pairs consecutive markers and converts frames to ms', () => {
    const segs = buildSegments([m(0, 0), m(60, 1), m(120, 0)])
    expect(segs).toHaveLength(2)
    expect(segs[0]).toMatchObject({ tStart: 0, tEnd: 1000, from: 0, to: 1 })
    expect(segs[1]).toMatchObject({ tStart: 1000, tEnd: 2000, from: 1, to: 0 })
  })

  test('takes easing from the marker ending the segment, not the one starting it', () => {
    // buildPath uses next.trans/next.ease; getting this backwards is silent.
    const segs = buildSegments([m(0, 0, 9, 9), m(60, 1, 4, 2)])
    expect(segs[0].trans).toBe(4)
    expect(segs[0].ease).toBe(2)
  })

  test('drops zero-length and out-of-order pairs', () => {
    expect(buildSegments([m(30, 0), m(30, 1), m(60, 0)])).toHaveLength(1)
  })

  test('a single marker yields no segments', () => {
    expect(buildSegments([m(0, 0.5)])).toHaveLength(0)
    expect(buildSegments([])).toHaveLength(0)
  })
})

describe('depthAt', () => {
  test('matches the engine interpolation at segment interior points', () => {
    const segs = buildSegments([m(0, 0, 0, 0), m(60, 1, 4, 2)])
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const expected = 0 + 1 * godotEase(t, 4, 2)
      expect(depthAt(segs, t * 1000)).toBeCloseTo(expected, 6)
    }
  })

  test('clamps outside the plan rather than extrapolating', () => {
    const segs = buildSegments([m(60, 0.25), m(120, 0.75)])
    expect(depthAt(segs, 0)).toBe(0.25)
    expect(depthAt(segs, -5000)).toBe(0.25)
    expect(depthAt(segs, 999999)).toBe(0.75)
  })

  test('finds the right segment across many segments', () => {
    const markers = Array.from({ length: 200 }, (_, i) => m(i * 30, i % 2))
    const segs = buildSegments(markers)
    // Midpoint of segment 50, linear: exactly halfway between its endpoints.
    const mid = (segs[50].tStart + segs[50].tEnd) / 2
    expect(depthAt(segs, mid)).toBeCloseTo((segs[50].from + segs[50].to) / 2, 6)
  })

  test('empty plan is 0, not NaN', () => {
    expect(depthAt([], 1234)).toBe(0)
  })
})

describe('linearize', () => {
  test('a linear segment is a single command', () => {
    const cmds = linearize(buildSegments([m(0, 0, 0, 0), m(30, 1, 0, 0)]))
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toMatchObject({ t: 0, pos: 1, dur: 500 })
  })

  test('subdivides a strongly eased segment', () => {
    // Expo-In over a full-range move deviates hugely from a straight line.
    const cmds = linearize(buildSegments([m(0, 0, 5, 0), m(60, 1, 5, 0)]))
    expect(cmds.length).toBeGreaterThan(1)
  })

  test('does not subdivide an eased segment whose travel is tiny', () => {
    // Same violent easing, 1% of the range: physically indistinguishable.
    const cmds = linearize(buildSegments([m(0, 0.5, 5, 0), m(60, 0.51, 5, 0)]))
    expect(cmds).toHaveLength(1)
  })

  test('never emits a command shorter than minCmdMs', () => {
    // 117 BPM style: markers ~31 frames apart with 2-frame grace notes.
    const markers: Marker[] = []
    for (let i = 0; i < 120; i++) markers.push(m(i * 2, i % 2 ? 1 : 0.7))
    const cmds = linearize(buildSegments(markers))
    expect(cmds.length).toBeGreaterThan(0)
    for (const c of cmds) expect(c.dur).toBeGreaterThanOrEqual(0)
    for (let i = 1; i < cmds.length; i++) {
      expect(cmds[i].t - cmds[i - 1].t).toBeGreaterThanOrEqual(
        DEFAULT_LINEARIZE.minCmdMs,
      )
    }
  })

  test('respects a custom minCmdMs', () => {
    const markers = Array.from({ length: 60 }, (_, i) => m(i * 3, i % 2))
    const cmds = linearize(buildSegments(markers), {
      ...DEFAULT_LINEARIZE,
      minCmdMs: 250,
    })
    for (let i = 1; i < cmds.length; i++) {
      expect(cmds[i].t - cmds[i - 1].t).toBeGreaterThanOrEqual(250)
    }
  })

  test('splits a move longer than maxCmdMs', () => {
    // 10 s linear ramp, 1 s ceiling.
    const cmds = linearize(buildSegments([m(0, 0, 0, 0), m(600, 1, 0, 0)]), {
      ...DEFAULT_LINEARIZE,
      maxCmdMs: 1000,
    })
    expect(cmds.length).toBeGreaterThanOrEqual(10)
    for (const c of cmds) expect(c.dur).toBeLessThanOrEqual(1000 + 1e-6)
  })

  test('commands are ordered and non-overlapping', () => {
    const markers = Array.from({ length: 400 }, (_, i) =>
      m(i * 7, (i % 3) / 2, i % 12, i % 4),
    )
    const cmds = linearize(buildSegments(markers))
    for (let i = 1; i < cmds.length; i++) {
      expect(cmds[i].t).toBeGreaterThan(cmds[i - 1].t)
      // A move must finish before the next one is issued, or the device is
      // being told to abandon a stroke mid-flight every time.
      expect(cmds[i - 1].t + cmds[i - 1].dur).toBeLessThanOrEqual(
        cmds[i].t + 1e-6,
      )
    }
  })

  test('positions stay inside the depth range of the source markers', () => {
    // Back/Elastic overshoot past 0..1 by design; the plan must not clip them
    // silently here — clamping is the sender's job — but it must not invent
    // wilder values than the easing itself produces.
    const cmds = linearize(buildSegments([m(0, 0, 10, 0), m(60, 1, 10, 0)]))
    for (const c of cmds) {
      expect(c.pos).toBeGreaterThanOrEqual(-0.5)
      expect(c.pos).toBeLessThanOrEqual(1.5)
    }
  })

  test('tracks the true curve within tolerance after linearisation', () => {
    const segs = buildSegments([m(0, 0, 5, 0), m(120, 1, 5, 0)])
    const cmds = linearize(segs)
    // Walk the piecewise-linear reconstruction and compare against depthAt.
    let prevPos = segs[0].from
    let prevT = segs[0].tStart
    let worst = 0
    for (const c of cmds) {
      const steps = 8
      for (let i = 1; i <= steps; i++) {
        const t = prevT + ((c.t + c.dur - prevT) * i) / steps
        const approx = prevPos + (c.pos - prevPos) * (i / steps)
        worst = Math.max(worst, Math.abs(approx - depthAt(segs, t)))
      }
      prevPos = c.pos
      prevT = c.t + c.dur
    }
    expect(worst).toBeLessThan(DEFAULT_LINEARIZE.tolerance * 2)
  })

  // The bench card's snap shapes: a one-frame attack, then an eased return.
  // On 2026-10-10 the merge kept only the return target, so every snap run
  // went out as a constant 0.
  const snaps = (cycles: number, period: number) => {
    const markers: Marker[] = []
    for (let i = 0; i < cycles; i++) {
      markers.push(m(i * period, 0, 4, 2), m(i * period + 1, 1, 0, 0))
    }
    markers.push(m(cycles * period, 0, 4, 2))
    return buildSegments(markers)
  }
  const peaks = (cmds: StrokeCmd[]) => cmds.filter((c) => c.pos > 0.99).length

  test('keeps every one-frame snap peak when the floor allows it (minCmdMs 20)', () => {
    const cmds = linearize(snaps(20, 10), { ...DEFAULT_LINEARIZE, minCmdMs: 20 })
    expect(peaks(cmds)).toBe(20)
    for (let i = 1; i < cmds.length; i++) {
      expect(cmds[i].t - cmds[i - 1].t).toBeGreaterThanOrEqual(20 - 1e-6)
      expect(cmds[i - 1].t + cmds[i - 1].dur).toBeLessThanOrEqual(cmds[i].t + 1e-6)
    }
  })

  test('keeps the snap peak at the default floor when the return has room (Whiplash)', () => {
    // 1 frame down, 14 back: 250 ms cycles against a 100 ms floor.
    const cmds = linearize(snaps(20, 15))
    expect(peaks(cmds)).toBe(20)
    expect(cmds.some((c) => c.pos < 0.01)).toBe(true)
  })

  test('cycles shorter than two floors halve in rate instead of vanishing', () => {
    // 360 cpm (10 frames) at 100 ms: both turnarounds cannot fit every cycle.
    const cmds = linearize(snaps(20, 10))
    expect(peaks(cmds)).toBeGreaterThanOrEqual(9)
    expect(cmds.some((c) => c.pos < 0.01)).toBe(true)
    for (let i = 1; i < cmds.length; i++) {
      expect(cmds[i].t - cmds[i - 1].t).toBeGreaterThanOrEqual(100 - 1e-6)
    }
    // No lag builds up: the plan still ends where the path does.
    expect(cmds.at(-1)!.t).toBeLessThanOrEqual(ms(200))
  })

  test('counts merged moves so the bench log can show them', () => {
    const markers: Marker[] = []
    for (let i = 0; i < 60; i++) markers.push(m(i * 2, i / 60))
    const cmds = linearize(buildSegments(markers))
    expect(cmds.reduce((n, c) => n + (c.merged ?? 0), 0)).toBeGreaterThan(0)
  })

  test('empty input yields no commands', () => {
    expect(linearize([])).toEqual([])
  })
})

describe('seekIndex', () => {
  const cmds: StrokeCmd[] = [
    { t: 0, pos: 0, dur: 100 },
    { t: 100, pos: 1, dur: 100 },
    { t: 200, pos: 0, dur: 100 },
    { t: 300, pos: 1, dur: 100 },
  ]

  test('lands on the first command at or after the time', () => {
    expect(seekIndex(cmds, -1)).toBe(0)
    expect(seekIndex(cmds, 0)).toBe(0)
    expect(seekIndex(cmds, 1)).toBe(1)
    expect(seekIndex(cmds, 100)).toBe(1)
    expect(seekIndex(cmds, 250)).toBe(3)
    expect(seekIndex(cmds, 99999)).toBe(4)
  })

  test('empty plan seeks to 0', () => {
    expect(seekIndex([], 500)).toBe(0)
  })
})

describe('buildStrokePlan', () => {
  test('produces a usable plan from a realistic marker set', () => {
    // Shape taken from videos/Drop/drop.bx: 117 BPM, depth alternating 1 / 0.7,
    // Quad-InOut easing, markers roughly every 31 frames.
    const markers: Marker[] = []
    for (let i = 0; i < 64; i++) {
      markers.push(m(Math.round(i * 30.8), i % 2 ? 0.7 : 1, 4, 2))
    }
    const { segments, commands } = buildStrokePlan(markers)
    expect(segments).toHaveLength(63)
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.length).toBeLessThanOrEqual(segments.length * 4)
    const lastMarkerMs = ms(markers[markers.length - 1].frame)
    for (const c of commands) {
      expect(c.t).toBeGreaterThanOrEqual(0)
      expect(c.t).toBeLessThanOrEqual(lastMarkerMs)
    }
  })
})

/** Moves that alternate between `lo` and `hi`, one every `period` ms, back to back. */
const zigzag = (n: number, period: number, lo = 0, hi = 1): StrokeCmd[] =>
  Array.from({ length: n }, (_, i) => ({
    t: i * period,
    pos: i % 2 ? lo : hi,
    dur: period,
  }))

const arrival = (c: StrokeCmd) => c.t + c.dur

describe('fitToMachine', () => {
  test('minMoveMs: triangle under the speed cap, trapezoid over it', () => {
    // 800 steps reaches 20000 steps/s exactly at 500000 steps/s2.
    expect(minMoveMs(800, 20000, 500000)).toBeCloseTo(80, 6)
    expect(minMoveMs(200, 20000, 500000)).toBeCloseTo(40, 6)
    expect(minMoveMs(5800, 20000, 500000)).toBeCloseTo(330, 6)
    expect(minMoveMs(0, 20000, 500000)).toBe(0)
  })

  test('a full-range zigzag it cannot meet keeps full strokes at a lower rate', () => {
    // A full 5800-step stroke needs 330 ms; these come every 100 ms.
    const cmds = zigzag(40, 100)
    const out = fitToMachine(cmds, 0, DEFAULT_FIT)
    expect(out.length).toBeLessThan(cmds.length / 3)
    expect(out.length).toBeGreaterThan(cmds.length / 6)
    const arrivals = new Set(cmds.map(arrival))
    let prev = 0
    for (const c of out) {
      // Full amplitude, still alternating, and landing on a kept turning point.
      expect(Math.abs(c.pos - prev)).toBe(1)
      expect(arrivals.has(arrival(c))).toBe(true)
      prev = c.pos
    }
    // Every stroke is one the machine can make, except the last few, where the
    // script ends before a reachable turning point and they are sent as is.
    const need = minMoveMs(5800, DEFAULT_FIT.maxSpeed, DEFAULT_FIT.maxAccel)
    expect(out.filter((c) => c.dur >= need).length).toBeGreaterThanOrEqual(out.length - 4)
    // Nothing lags: the plan still ends where the script ends.
    expect(arrival(out[out.length - 1])).toBe(arrival(cmds[cmds.length - 1]))
  })

  test('counts every dropped move in merged', () => {
    const cmds = zigzag(40, 100)
    const out = fitToMachine(cmds, 0, DEFAULT_FIT)
    const accounted = out.reduce((s, c) => s + 1 + (c.merged ?? 0), 0)
    // The tail that no reachable stroke fits into is kept as is, so every input
    // move is either sent or counted.
    expect(accounted).toBe(cmds.length)
  })

  test('keeps the bigger excursion when wiggles ride on a stroke', () => {
    // Full strokes every 100 ms, then a half one: all too quick to make. The
    // first reachable turning point (500 ms) is the 0.5 one; the stroke should
    // still go to 1.
    const cmds: StrokeCmd[] = [
      { t: 0, pos: 1, dur: 100 },
      { t: 100, pos: 0.0, dur: 100 },
      { t: 200, pos: 1, dur: 100 },
      { t: 300, pos: 0.0, dur: 100 },
      { t: 400, pos: 0.5, dur: 100 },
      { t: 500, pos: 0.0, dur: 100 },
    ]
    const out = fitToMachine(cmds, 0, DEFAULT_FIT)
    expect(out[0].pos).toBe(1)
  })

  test('a path the machine can follow comes out unchanged', () => {
    const cmds = zigzag(20, 400)
    expect(fitToMachine(cmds, 0, DEFAULT_FIT)).toEqual(cmds)
    // Small fast wiggles are reachable too: 0.05 of 5800 is 290 steps, 48 ms.
    const small = zigzag(20, 60, 0.5, 0.55)
    expect(fitToMachine(small, 0.5, DEFAULT_FIT)).toEqual(small)
  })

  test('a lone jump it cannot make is left alone', () => {
    const cmds: StrokeCmd[] = [
      { t: 0, pos: 0, dur: 500 },
      { t: 500, pos: 1, dur: 50 },
      { t: 550, pos: 1, dur: 500 },
    ]
    expect(fitToMachine(cmds, 0, DEFAULT_FIT)).toEqual(cmds)
  })

  test('off is a no-op in buildStrokePlan', () => {
    const markers: Marker[] = []
    for (let i = 0; i < 40; i++) markers.push(m(i * 6, i % 2 ? 0 : 1))
    const off = buildStrokePlan(markers, { ...DEFAULT_LINEARIZE, minCmdMs: 20 })
    expect(off.commands).toEqual(linearize(off.segments, { ...DEFAULT_LINEARIZE, minCmdMs: 20 }))
    const on = buildStrokePlan(markers, { ...DEFAULT_LINEARIZE, minCmdMs: 20 }, DEFAULT_FIT)
    expect(on.commands.length).toBeLessThan(off.commands.length)
  })
})