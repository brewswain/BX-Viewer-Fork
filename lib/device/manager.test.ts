/**
 * Whole-chain test: markers → plan → driver → Buttplug transport → simulator.
 *
 * Everything except React and the `<video>` element. If a `.bx` file would
 * drive the machine correctly, it drives the simulator correctly here.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createButtplugSim, type Simulator } from '@/scripts/buttplug-sim'
import { deviceManager } from './manager'
import type { Marker } from '@/lib/player/types'
import { FPS } from '@/lib/player/constants'

let nextPort = 47310
const sims: Simulator[] = []

function startSim() {
  const sim = createButtplugSim({ port: nextPort++, quiet: true })
  sims.push(sim)
  return sim
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await wait(5)
  }
  throw new Error('condition not met within timeout')
}

const m = (frame: number, depth: number, trans = 0, ease = 0): Marker => ({
  frame,
  depth,
  trans,
  ease,
})

/** Alternating full-range strokes every 30 frames (500 ms). */
function strokeMarkers(count = 12): Marker[] {
  return Array.from({ length: count }, (_, i) => m(i * 30, i % 2))
}

/** Feed the manager a run of frames as the engine's rAF loop would. */
function playThrough(fromMs: number, toMs: number, stepMs = 16) {
  for (let t = fromMs; t <= toMs; t += stepMs) {
    deviceManager.tick(t, true)
  }
}

async function connectTo(sim: Simulator, extra = {}) {
  deviceManager.configure({
    backend: 'buttplug',
    buttplugUrl: `ws://127.0.0.1:${sim.port}`,
    enabled: true,
    rangeMin: 0,
    rangeMax: 1,
    invert: false,
    offsetMs: 0,
    minCmdMs: 100,
    ...extra,
  })
  await deviceManager.connect()
  await until(() => deviceManager.getSnapshot().devices.length > 0)
}

afterEach(() => {
  deviceManager.clearMarkers()
  deviceManager.disconnect()
  for (const s of sims.splice(0)) s.stop()
})

describe('deviceManager end to end', () => {
  test('drives the simulator from a marker list', async () => {
    const sim = startSim()
    await connectTo(sim)
    deviceManager.setMarkers(strokeMarkers())

    expect(deviceManager.getSnapshot().armed).toBe(true)
    playThrough(0, 2200)
    await until(() => sim.moves.length >= 4)

    // Alternating extremes, in order.
    const positions = sim.moves.map((mv) => Math.round(mv.position))
    expect(positions.slice(0, 4)).toEqual([1, 0, 1, 0])
    for (const mv of sim.moves) {
      expect(mv.duration).toBeGreaterThan(0)
      expect(mv.duration).toBeLessThanOrEqual(1000)
    }
  })

  test('stays silent until output is enabled', async () => {
    const sim = startSim()
    await connectTo(sim, { enabled: false })
    deviceManager.setMarkers(strokeMarkers())

    expect(deviceManager.getSnapshot().armed).toBe(false)
    playThrough(0, 2000)
    await wait(50)
    expect(sim.moves).toHaveLength(0)
  })

  test('stays silent with no plan loaded', async () => {
    const sim = startSim()
    await connectTo(sim)
    // No setMarkers call at all.
    expect(deviceManager.getSnapshot().armed).toBe(false)
    playThrough(0, 2000)
    await wait(50)
    expect(sim.moves).toHaveLength(0)
  })

  test('clearMarkers stops the device mid-playback', async () => {
    const sim = startSim()
    await connectTo(sim)
    deviceManager.setMarkers(strokeMarkers())
    playThrough(0, 1200)
    await until(() => sim.moves.length >= 2)

    const before = sim.moves.length
    deviceManager.clearMarkers()
    await until(() => sim.stops >= 1)

    playThrough(1216, 3000)
    await wait(50)
    expect(sim.moves).toHaveLength(before)
    expect(deviceManager.getSnapshot().armed).toBe(false)
  })

  test('pausing stops the device and resuming picks up in place', async () => {
    const sim = startSim()
    await connectTo(sim)
    deviceManager.setMarkers(strokeMarkers())

    playThrough(0, 700)
    await until(() => sim.moves.length >= 2)
    deviceManager.tick(700, false)
    await until(() => sim.stops >= 1)

    const before = sim.moves.length
    playThrough(700, 1600)
    await until(() => sim.moves.length > before)
  })

  test('the stroke range setting reaches the wire', async () => {
    const sim = startSim()
    await connectTo(sim, { rangeMin: 0.25, rangeMax: 0.75 })
    deviceManager.setMarkers(strokeMarkers())

    playThrough(0, 2000)
    await until(() => sim.moves.length >= 3)
    for (const mv of sim.moves) {
      expect(mv.position).toBeGreaterThanOrEqual(0.25 - 1e-6)
      expect(mv.position).toBeLessThanOrEqual(0.75 + 1e-6)
    }
  })

  test('invert flips the stroke', async () => {
    const sim = startSim()
    await connectTo(sim, { invert: true })
    deviceManager.setMarkers(strokeMarkers())

    playThrough(0, 1200)
    await until(() => sim.moves.length >= 2)
    // Without invert the first command targets depth 1.
    expect(Math.round(sim.moves[0].position)).toBe(0)
  })

  test('raising minCmdMs replans and thins dense paths', async () => {
    const sim = startSim()
    // Markers every 6 frames = 100 ms, i.e. right at the default floor.
    const dense = Array.from({ length: 60 }, (_, i) => m(i * 6, i % 2))

    await connectTo(sim, { minCmdMs: 100 })
    deviceManager.setMarkers(dense)
    const atDefault = deviceManager.getSnapshot().planCommands

    deviceManager.configure({ minCmdMs: 500 })
    const atCoarse = deviceManager.getSnapshot().planCommands

    expect(atDefault).toBeGreaterThan(0)
    expect(atCoarse).toBeLessThan(atDefault)
  })

  test('offset shifts device timing relative to the video', async () => {
    const sim = startSim()
    await connectTo(sim, { offsetMs: 400 })
    deviceManager.setMarkers(strokeMarkers())

    // Video time 0..300 is plan time −400..−100: before the path begins.
    playThrough(0, 300)
    await wait(50)
    const early = sim.moves.length

    playThrough(316, 1200)
    await until(() => sim.moves.length > early)
  })

  test('a seek does not replay the intervening commands', async () => {
    const sim = startSim()
    await connectTo(sim)
    deviceManager.setMarkers(strokeMarkers())

    playThrough(0, 500)
    await until(() => sim.moves.length >= 1)
    const before = sim.moves.length

    // Jump most of the way through the plan in one frame.
    deviceManager.tick(4800, true)
    await wait(60)
    // At most one catch-up move, not the ~8 commands that were skipped.
    expect(sim.moves.length - before).toBeLessThanOrEqual(1)
  })

  test('losing the connection stops driving without throwing', async () => {
    const sim = startSim()
    await connectTo(sim)
    deviceManager.setMarkers(strokeMarkers())
    playThrough(0, 600)
    await until(() => sim.moves.length >= 1)

    sim.stop()
    await until(() => deviceManager.getSnapshot().connection !== 'connected', 3000)
    expect(() => playThrough(616, 2000)).not.toThrow()
    expect(deviceManager.getSnapshot().armed).toBe(false)
  })

  test('plan length matches what the planner produces for the markers', async () => {
    const sim = startSim()
    await connectTo(sim)
    const markers = strokeMarkers(20)
    deviceManager.setMarkers(markers)
    // 19 segments of 500 ms, all linear: one command each.
    expect(deviceManager.getSnapshot().planCommands).toBe(19)
    // Sanity-check the frame→ms conversion the whole chain depends on.
    expect(markers[1].frame / FPS).toBeCloseTo(0.5, 6)
  })
})
