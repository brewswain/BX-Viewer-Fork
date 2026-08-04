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
  DEFAULT_LINEARIZE,
  depthAt,
  linearize,
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
