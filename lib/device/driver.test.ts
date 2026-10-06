/**
 * Driver behaviour against a recording fake backend.
 *
 * The scheduler is the part that fails invisibly — a device that is 300 ms out
 * of sync still moves, so nothing looks broken. These lock down the timing
 * rules: one move per due command, one catch-up per seek, silence while paused.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  StrokeDriver,
  SWAP_LEAVE_MAX_MS,
  SWAP_OUT_DEPTH,
  SAFE_FULL_RAIL_MS,
  type StrokePlan,
} from './driver'
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

/**
 * Where the timing tests start. The opening catch-up from an unknown position
 * takes the capped 1.5 s, so the path proper is only being followed after it;
 * 2000 keeps squarePlan's phase, a stroke in from 0 starting right there.
 */
const T0 = 2000

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

  /** Play through the opening catch-up, stopping one frame short of T0. */
  function onPath(d = driver, b = backend) {
    for (let t = 0; t < T0; t += 16) d.tick(t, true)
    b.reset()
  }

  function freshOnPath() {
    const b = new FakeBackend()
    const d = new StrokeDriver()
    d.setBackend(b)
    d.setPlan(squarePlan())
    d.setRunning(true)
    onPath(d, b)
    return { d, b }
  }

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

  test('the opening catch-up is capped, from a position it cannot know', () => {
    driver.tick(0, true)
    // The machine could be anywhere on the rail, so any target is a full rail
    // away: the first two strokes end too soon to reach at 1.5 s a rail, and
    // the third, ending at 1500, is reached exactly on schedule.
    expect(backend.moves).toHaveLength(1)
    expect(backend.moves[0].pos).toBeCloseTo(1, 6)
    expect(backend.moves[0].dur).toBeCloseTo(SAFE_FULL_RAIL_MS, 3)
  })

  test('a catch-up lands on a stroke end on schedule, never mid-stroke', () => {
    driver.tick(250, true)
    expect(backend.moves).toHaveLength(1)
    expect(backend.moves[0].pos).toBeCloseTo(0, 6)
    expect(backend.moves[0].dur).toBeCloseTo(1750, 3) // arriving at 2000
    // And the path then carries on from exactly there, at its own speed.
    for (let t = 266; t <= 2016; t += 16) driver.tick(t, true)
    expect(backend.moves).toHaveLength(2)
    expect(backend.moves[1].pos).toBeCloseTo(1, 6)
    expect(backend.moves[1].dur).toBeGreaterThan(480)
  })

  test('once on the path, a due command fires directly', () => {
    onPath()
    driver.tick(T0, true)
    expect(backend.moves).toHaveLength(1)
    expect(backend.moves[0].pos).toBeCloseTo(1, 6)
    expect(backend.moves[0].dur).toBeCloseTo(500, 3)
  })

  test('no seek, anywhere, makes a catch-up faster than the cap', () => {
    onPath()
    let t = T0
    for (const to of [3100, 4250, 6020, 7490, 2600, 9000]) {
      // Play a little first so the machine is mid-stroke when the seek lands.
      for (const end = t + 300; t < end; t += 16) driver.tick(t, true)
      backend.reset()
      t = to
      driver.tick(t, true)
      const mv = backend.moves[0]
      // Mid-stroke, the machine could be anywhere along a full-rail stroke.
      const travel = Math.max(mv.pos, 1 - mv.pos)
      expect(mv.dur).toBeGreaterThanOrEqual(travel * SAFE_FULL_RAIL_MS - 1e-6)
    }
  })

  test('advancing normally issues each command exactly once', () => {
    // Step in 16 ms frames across three strokes: commands at T0, +500, +1000.
    onPath()
    for (let t = T0; t <= T0 + 1400; t += 16) driver.tick(t, true)
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

  test('resuming after a pause glides back in at the capped speed', () => {
    onPath()
    driver.tick(T0, true)
    driver.tick(T0 + 100, false)
    backend.reset()
    driver.tick(T0 + 100, true)
    // Paused 100 ms into a full stroke, so it could be anywhere on the rail:
    // the first stroke end at least 1.5 s away is the one ending at 4000.
    expect(backend.moves).toHaveLength(1)
    expect(backend.moves[0].pos).toBeCloseTo(0, 6)
    expect(backend.moves[0].dur).toBeCloseTo(1900, 3)
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
    // And playback continues from there rather than from the old index, once
    // the capped glide lands at 2000.
    backend.reset()
    for (let t = 216; t <= 2600; t += 16) driver.tick(t, true)
    expect(backend.moves.length).toBeGreaterThan(0)
  })

  test('a stalled tab collapses backlog into one move, shortened by lateness', () => {
    onPath()
    driver.tick(T0, true)
    backend.reset()
    // Jump 200 ms — under the 250 ms seek threshold, so this is "we fell
    // behind", not "the user scrubbed". Two commands come due at once.
    driver.tick(T0 + 200, true)
    driver.tick(T0 + 400, true)
    driver.tick(T0 + 600, true)
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
    // Video time 0 is now plan time −500. The catch-up lands on the stroke
    // ending at plan 1000, which is video 1500, 1.5 s away.
    driver.tick(0, true)
    expect(backend.moves).toHaveLength(1)
    expect(backend.moves[0].pos).toBeCloseTo(0, 6)
    expect(backend.moves[0].dur).toBeCloseTo(1500, 3)
    // The stroke the plan starts at 1000 fires at video 1500.
    for (let t = 16; t < 1500; t += 16) driver.tick(t, true)
    expect(backend.moves).toHaveLength(1)
    driver.tick(1500, true)
    expect(backend.moves).toHaveLength(2)
    expect(backend.moves[1].pos).toBeCloseTo(1, 6)
  })

  test('leadMs shifts the plan earlier', () => {
    driver.setOptions({ leadMs: 250 })
    driver.tick(0, true)
    // Plan time 250: the stroke end at plan 2000 is reached at video 1750.
    expect(backend.moves[0].pos).toBeCloseTo(0, 6)
    expect(backend.moves[0].dur).toBeCloseTo(1750, 3)
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

  // The whole plan is in media time and every duration handed to a device is in
  // wall time. At 1× those are the same number, which is exactly why getting
  // this wrong is invisible until someone changes speed — and then the machine
  // runs a whole stroke behind while still looking like it is working.
  describe('playback rate', () => {
    test('a due command is commanded in wall time, not plan time', () => {
      // The first stroke spans 500 ms of video. At 2× it goes past in 250 ms of
      // real time, so that is how long the device has to complete it.
      onPath()
      driver.tick(T0, true, 2)
      expect(backend.moves[0].dur).toBeCloseTo(250, 3)

      const { d, b } = freshOnPath()
      d.tick(T0, true, 0.5)
      expect(b.moves[0].dur).toBeCloseTo(1000, 3)
    })

    test('an omitted rate still means 1×', () => {
      onPath()
      driver.tick(T0, true)
      expect(backend.moves[0].dur).toBeCloseTo(500, 3)
    })

    test('lateness is taken off before the conversion, not after', () => {
      onPath()
      driver.tick(T0, true, 2)
      backend.reset()
      // Two 300 ms steps: each is under the scaled seek threshold, so the
      // second lands 100 ms past the 500 ms command rather than re-anchoring.
      // 400 ms of video is left to cover, which at 2× is 200 ms of real time.
      driver.tick(T0 + 300, true, 2)
      driver.tick(T0 + 600, true, 2)
      expect(backend.moves).toHaveLength(1)
      expect(backend.moves[0].dur).toBeCloseTo(200, 3)
    })

    test('the minimum move length is still a floor at speed', () => {
      for (let t = 0; t < 8000; t += 240) driver.tick(t, true, 4)
      for (const mv of backend.moves) expect(mv.dur).toBeGreaterThanOrEqual(20)
    })

    test('the seek threshold scales, so fast playback is not read as a seek', () => {
      driver.tick(0, true, 4)
      backend.reset()
      // 400 ms of video in one frame is over the 250 ms threshold but is only
      // 100 ms of real time at 4× — falling behind, not scrubbing.
      driver.tick(400, true, 4)
      expect(driver.stats.seeks).toBe(0)
      // The same jump at 1× is a scrub.
      driver.setPlan(squarePlan())
      driver.tick(0, true)
      driver.tick(400, true)
      expect(driver.stats.seeks).toBe(1)
    })

    test('the catch-up cap is in wall time', () => {
      // At 4× the plan races past, so the 1.5 s of real time the cap needs is
      // 6 s of plan: the first stroke end at least that far off is 6500.
      driver.tick(250, true, 4)
      expect(backend.moves).toHaveLength(1)
      expect(backend.moves[0].pos).toBeCloseTo(1, 6)
      expect(backend.moves[0].dur).toBeCloseTo((6500 - 250) / 4, 3)
    })

    test('a nonsense rate is treated as 1× rather than dividing by it', () => {
      onPath()
      driver.tick(T0, true, 0)
      expect(backend.moves[0].dur).toBeCloseTo(500, 3)

      const { d, b } = freshOnPath()
      d.tick(T0, true, NaN)
      expect(b.moves[0].dur).toBeCloseTo(500, 3)
    })
  })

  // Two difficulties of one video can sit at opposite ends of the rail at the
  // same instant. The plain re-anchor would cover that in 250 ms, which on a
  // stroker is a ram to the hilt; a swap must hand over only at depth ~0.
  describe('track swap', () => {
    /** squarePlan's mirror image: deep exactly where squarePlan is out. */
    function mirrorPlan(count = 20): StrokePlan {
      const markers: Marker[] = []
      for (let i = 0; i < count; i++) markers.push(m(i * 30, (i + 1) % 2))
      return buildStrokePlan(markers)
    }

    /** 10 s parked at the hilt: never comes out by itself. */
    function parkPlan(): StrokePlan {
      return buildStrokePlan([m(0, 1), m(600, 1)])
    }

    const play = (from: number, to: number) => {
      for (let t = from; t <= to; t += 16) driver.tick(t, true)
    }

    test('waits for the old track to come out, then for the new one', () => {
      onPath()
      play(T0, T0 + 192) // on the way in to 1
      backend.reset()
      driver.swapPlan(mirrorPlan())
      expect(driver.swapPhase()).toBe('leave')

      // The old track brings the machine out over the next stroke by itself;
      // the mirror is deep when it gets there and comes out a stroke later.
      play(T0 + 208, T0 + 1440)
      expect(driver.swapPhase()).toBe('out')
      expect(backend.moves).toHaveLength(1)
      expect(backend.moves[0].pos).toBeCloseTo(0, 6)

      play(T0 + 1456, T0 + 2100)
      expect(driver.swapPhase()).toBeNull()
      // Nothing deeper than the out threshold until the mirror's own stroke
      // in, which leaves from 0 and takes its full designed length.
      const deep = backend.moves.filter((mv) => mv.pos > SWAP_OUT_DEPTH)
      expect(deep.length).toBeGreaterThan(0)
      for (const mv of deep) expect(mv.dur).toBeGreaterThan(400)
    })

    test('a track that will not come out gets a slow retract instead', () => {
      driver.setPlan(parkPlan())
      play(0, 1000)
      backend.reset()
      driver.swapPlan(squarePlan())
      play(1008, 1000 + SWAP_LEAVE_MAX_MS + 100)
      const retract = backend.moves.at(-1)!
      expect(retract.pos).toBeCloseTo(0, 6)
      expect(retract.dur).toBe(SAFE_FULL_RAIL_MS)
      expect(driver.swapPhase()).toBe('retract')
    })

    test('a swap made while paused retracts on resume, never re-anchors', () => {
      play(0, 192)
      driver.tick(200, false)
      driver.swapPlan(mirrorPlan())
      backend.reset()
      driver.tick(200, true)
      expect(backend.moves).toHaveLength(1)
      expect(backend.moves[0].pos).toBeCloseTo(0, 6)
      // Sized from the deepest commanded depth, not the 250 ms seek settle.
      expect(backend.moves[0].dur).toBe(SAFE_FULL_RAIL_MS)
    })

    test('a pause mid-retract resends the whole retract', () => {
      play(0, 192)
      driver.tick(200, false)
      driver.swapPlan(mirrorPlan())
      driver.tick(200, true)
      driver.tick(400, false)
      backend.reset()
      driver.tick(400, true)
      expect(backend.moves).toHaveLength(1)
      expect(backend.moves[0].dur).toBe(SAFE_FULL_RAIL_MS)
    })

    test('the first track loads directly, with nothing to withdraw from', () => {
      const d = new StrokeDriver()
      d.setBackend(backend)
      d.setRunning(true)
      d.swapPlan(squarePlan())
      expect(d.swapPhase()).toBeNull()
      d.tick(0, true)
      expect(backend.moves).toHaveLength(1)
    })

    test('a rebuild mid-swap does not cut the gate short', () => {
      play(0, 192)
      driver.swapPlan(mirrorPlan())
      driver.setPlan(mirrorPlan())
      expect(driver.swapPhase()).toBe('leave')
    })

    test('clearing the plan cancels the swap', () => {
      play(0, 192)
      driver.swapPlan(mirrorPlan())
      driver.setPlan({ segments: [], commands: [] })
      expect(driver.swapPhase()).toBeNull()
    })
  })
})
