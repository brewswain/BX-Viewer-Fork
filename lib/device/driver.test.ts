/**
 * Driver behaviour against a recording fake backend.
 *
 * The scheduler is the part that fails invisibly — a device that is 300 ms out
 * of sync still moves, so nothing looks broken. These lock down the timing
 * rules: one move per due command, one catch-up per seek, silence while paused.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { StrokeDriver, type StrokePlan } from './driver'
import { buildStrokePlan } from './plan'
import type { Marker } from '@/lib/player/types'
import {
  Emitter,
  type ConnectionState,
  type DeviceBackend,
  type DeviceInfo,
  type EaseHint,
} from './types'

type Move = { pos: number; dur: number }

class FakeBackend extends Emitter implements DeviceBackend {
  readonly kind = 'buttplug' as const
  readonly devices: DeviceInfo[] = []
  readonly state: ConnectionState = 'connected'
  moves: Move[] = []
  stops = 0

  async connect(): Promise<void> {}
  disconnect(): void {}
  move(pos: number, dur: number, _hint?: EaseHint): void {
    this.moves.push({ pos, dur })
  }
  stop(): void {
    this.stops++
  }
  reset(): void {
    this.moves = []
    this.stops = 0
  }
}

const m = (frame: number, depth: number, trans = 0, ease = 0): Marker => ({
  frame,
  depth,
  trans,
  ease,
})

/** Square-ish stroke: full range every 30 frames (500 ms), purely linear. */
function squarePlan(count = 20): StrokePlan {
  const markers: Marker[] = []
  for (let i = 0; i < count; i++) markers.push(m(i * 30, i % 2))
  return buildStrokePlan(markers)
}

describe('StrokeDriver', () => {
  let backend: FakeBackend
  let driver: StrokeDriver

  beforeEach(() => {
    backend = new FakeBackend()
    driver = new StrokeDriver()
    driver.setBackend(backend)
    driver.setPlan(squarePlan())
    driver.setRunning(true)
  })

  test('does nothing until running', () => {
    const d = new StrokeDriver()
    d.setBackend(backend)
    d.setPlan(squarePlan())
    d.tick(0, true)
    d.tick(1000, true)
    expect(backend.moves).toHaveLength(0)
  })

  test('does nothing without a backend', () => {
    const d = new StrokeDriver()
    d.setPlan(squarePlan())
    d.setRunning(true)
    expect(() => d.tick(500, true)).not.toThrow()
  })

  test('tolerates an empty plan', () => {
    driver.setPlan({ segments: [], commands: [] })
    driver.tick(0, true)
    driver.tick(500, true)
    expect(backend.moves).toHaveLength(0)
  })

  test('first active frame issues the command already due, not an anchor', () => {
    driver.tick(0, true)
    // The plan's first command starts at t=0, so it fires directly — sending a
    // corrective move to the current position first would only be cancelled.
    expect(backend.moves).toHaveLength(1)
    expect(backend.moves[0].pos).toBeCloseTo(1, 6)
    expect(backend.moves[0].dur).toBeCloseTo(500, 3)
  })

  test('starting mid-segment anchors to the interpolated path position', () => {
    // 250 ms into a 0→1 linear segment that spans 0–500 ms, nothing due until
    // 500, so there is room for a correction.
    driver.tick(250, true)
    expect(backend.moves).toHaveLength(1)
    expect(backend.moves[0].pos).toBeCloseTo(0.5, 3)
  })

  test('skips the anchor when the next command is imminent', () => {
    // 490 ms in: only 10 ms until the 500 ms command, so cramming a correction
    // into that gap would be a slam.
    driver.tick(490, true)
    expect(backend.moves).toHaveLength(0)
    driver.tick(506, true)
    expect(backend.moves).toHaveLength(1)
  })

  test('advancing normally issues each command exactly once', () => {
    // Step in 16 ms frames across three strokes: commands at 0, 500 and 1000.
    for (let t = 0; t <= 1400; t += 16) driver.tick(t, true)
    expect(backend.moves).toHaveLength(3)
    expect(backend.moves.map((mv) => Math.round(mv.pos))).toEqual([1, 0, 1])
  })

  test('a frame with nothing due sends nothing', () => {
    driver.tick(0, true)
    backend.reset()
    driver.tick(16, true)
    driver.tick(32, true)
    expect(backend.moves).toHaveLength(0)
  })

  test('pausing stops the device once, not every frame', () => {
    driver.tick(0, true)
    backend.reset()
    driver.tick(100, false)
    driver.tick(116, false)
    driver.tick(132, false)
    expect(backend.stops).toBe(1)
    expect(backend.moves).toHaveLength(0)
  })

  test('resuming after a pause re-anchors with a catch-up move', () => {
    driver.tick(0, true)
    driver.tick(100, false)
    backend.reset()
    driver.tick(100, true)
    expect(backend.moves).toHaveLength(1)
    expect(backend.moves[0].dur).toBe(250) // seekSettleMs
  })

  test('a seek issues one catch-up move, not the skipped commands', () => {
    driver.tick(0, true)
    backend.reset()
    driver.tick(5000, true)
    expect(backend.moves).toHaveLength(1)
    expect(driver.stats.seeks).toBe(1)
  })

  test('seeking backwards works the same way', () => {
    for (let t = 0; t <= 3000; t += 16) driver.tick(t, true)
    backend.reset()
    driver.tick(200, true)
    expect(backend.moves).toHaveLength(1)
    // And playback continues from there rather than from the old index.
    backend.reset()
    for (let t = 216; t <= 1200; t += 16) driver.tick(t, true)
    expect(backend.moves.length).toBeGreaterThan(0)
  })

  test('a stalled tab collapses backlog into one move, shortened by lateness', () => {
    driver.tick(0, true)
    backend.reset()
    // Jump 200 ms — under the 250 ms seek threshold, so this is "we fell
    // behind", not "the user scrubbed". Two commands come due at once.
    driver.tick(200, true)
    driver.tick(400, true)
    driver.tick(600, true)
    // 600 ms passes the 500 ms command; it should be issued once, short.
    const last = backend.moves[backend.moves.length - 1]
    expect(last.dur).toBeLessThan(500)
    expect(last.dur).toBeGreaterThanOrEqual(20)
  })

  test('never issues a zero or negative duration', () => {
    driver.tick(0, true)
    for (let t = 0; t < 8000; t += 240) driver.tick(t, true)
    for (const mv of backend.moves) expect(mv.dur).toBeGreaterThanOrEqual(20)
  })

  test('offsetMs shifts the plan later', () => {
    driver.setOptions({ offsetMs: 500 })
    // Video time 0 is now plan time −500: before the path starts, so the driver
    // parks at the opening depth and waits.
    driver.tick(0, true)
    expect(backend.moves).toHaveLength(1)
    expect(backend.moves[0].pos).toBeCloseTo(0, 6)
    // The stroke that would have fired at video time 0 fires at 500 instead.
    for (let t = 16; t < 500; t += 16) driver.tick(t, true)
    expect(backend.moves).toHaveLength(1)
    driver.tick(500, true)
    expect(backend.moves).toHaveLength(2)
    expect(backend.moves[1].pos).toBeCloseTo(1, 6)
  })

  test('leadMs shifts the plan earlier', () => {
    driver.setOptions({ leadMs: 250 })
    driver.tick(0, true)
    // Plan time 250 = halfway up the first stroke.
    expect(backend.moves[0].pos).toBeCloseTo(0.5, 3)
  })

  test('mapping applies range and invert at send time', () => {
    // The first command targets depth 1, i.e. the top of the mapped range.
    driver.setOptions({ mapping: { rangeMin: 0.2, rangeMax: 0.8, invert: false } })
    driver.tick(0, true)
    expect(backend.moves[0].pos).toBeCloseTo(0.8, 6)

    backend.reset()
    driver.setOptions({ mapping: { rangeMin: 0.2, rangeMax: 0.8, invert: true } })
    driver.setPlan(squarePlan()) // reset index
    driver.tick(0, true)
    expect(backend.moves[0].pos).toBeCloseTo(0.2, 6)
  })

  test('mapping changes take effect without replanning', () => {
    driver.tick(0, true)
    driver.setOptions({ mapping: { rangeMin: 0, rangeMax: 0.5, invert: false } })
    backend.reset()
    for (let t = 16; t <= 600; t += 16) driver.tick(t, true)
    for (const mv of backend.moves) expect(mv.pos).toBeLessThanOrEqual(0.5)
  })

  test('setRunning(false) stops the device and silences ticks', () => {
    driver.tick(0, true)
    backend.reset()
    driver.setRunning(false)
    expect(backend.stops).toBe(1)
    for (let t = 16; t <= 2000; t += 16) driver.tick(t, true)
    expect(backend.moves).toHaveLength(0)
  })

  test('swapping the backend stops the old one', () => {
    driver.tick(0, true)
    const next = new FakeBackend()
    driver.setBackend(next)
    expect(backend.stops).toBe(1)
    driver.tick(600, true)
    expect(next.moves.length).toBeGreaterThan(0)
  })

  test('positions stay inside 0..1 even where easing overshoots', () => {
    // TRANS_BACK (10) undershoots below zero on the way out.
    driver.setPlan(buildStrokePlan([m(0, 0, 10, 0), m(60, 1, 10, 0), m(120, 0, 10, 0)]))
    for (let t = 0; t <= 2000; t += 16) driver.tick(t, true)
    for (const mv of backend.moves) {
      expect(mv.pos).toBeGreaterThanOrEqual(0)
      expect(mv.pos).toBeLessThanOrEqual(1)
    }
  })

  test('running past the end of the plan is silent', () => {
    for (let t = 0; t <= 12000; t += 16) driver.tick(t, true)
    backend.reset()
    for (let t = 12000; t <= 14000; t += 16) driver.tick(t, true)
    expect(backend.moves).toHaveLength(0)
  })
})
