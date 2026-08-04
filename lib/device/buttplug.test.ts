/**
 * End-to-end transport tests against the simulator in `scripts/buttplug-sim.ts`.
 *
 * These are the only tests that exercise real sockets and real JSON framing —
 * everything the hand-written protocol client could get wrong (message
 * envelope, handshake order, device selection, timing gap) fails here rather
 * than silently on a machine at 2 am.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createButtplugSim, type Simulator } from '@/scripts/buttplug-sim'
import { ButtplugBackend } from './buttplug'

/** Ports well outside Intiface's default so a running instance can't collide. */
let nextPort = 47210

const sims: Simulator[] = []
const backends: ButtplugBackend[] = []

function startSim(opts: Parameters<typeof createButtplugSim>[0] = {}) {
  const sim = createButtplugSim({ port: nextPort++, quiet: true, ...opts })
  sims.push(sim)
  return sim
}

function makeBackend(port: number, opts = {}) {
  const b = new ButtplugBackend({ url: `ws://127.0.0.1:${port}`, ...opts })
  backends.push(b)
  return b
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll until `check` passes, so tests don't depend on a fixed sleep. */
async function until(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await wait(5)
  }
  throw new Error('condition not met within timeout')
}

afterEach(() => {
  for (const b of backends.splice(0)) b.disconnect()
  for (const s of sims.splice(0)) s.stop()
})

describe('ButtplugBackend', () => {
  test('connects, handshakes and finds the linear device', async () => {
    const sim = startSim()
    const backend = makeBackend(sim.port)

    const states: string[] = []
    backend.on('state', (s) => states.push(s))

    await backend.connect()
    await until(() => backend.devices.length > 0)

    expect(backend.state).toBe('connected')
    expect(states).toContain('connecting')
    expect(states).toContain('connected')
    expect(backend.devices).toHaveLength(1)
    expect(backend.devices[0].linear).toBe(true)
    expect(backend.devices[0].name).toContain('Simulator')
    expect(backend.targetIndex).toBe(0)
  })

  test('sends LinearCmd with position and duration intact', async () => {
    const sim = startSim()
    const backend = makeBackend(sim.port)
    await backend.connect()
    await until(() => backend.targetIndex !== null)

    backend.move(0.25, 400)
    backend.move(0.9, 120)
    await until(() => sim.moves.length >= 2)

    expect(sim.moves[0]).toMatchObject({ position: 0.25, duration: 400 })
    expect(sim.moves[1]).toMatchObject({ position: 0.9, duration: 120 })
  })

  test('clamps position and rounds duration to whole ms', async () => {
    const sim = startSim()
    const backend = makeBackend(sim.port)
    await backend.connect()
    await until(() => backend.targetIndex !== null)

    backend.move(1.4, 33.7)
    backend.move(-0.2, 0.2)
    await until(() => sim.moves.length >= 2)

    expect(sim.moves[0].position).toBe(1)
    expect(sim.moves[0].duration).toBe(34)
    expect(sim.moves[1].position).toBe(0)
    // Never zero — a zero-duration move is an instantaneous slam.
    expect(sim.moves[1].duration).toBeGreaterThanOrEqual(1)
  })

  test('stop() issues StopDeviceCmd', async () => {
    const sim = startSim()
    const backend = makeBackend(sim.port)
    await backend.connect()
    await until(() => backend.targetIndex !== null)

    backend.stop()
    await until(() => sim.stops >= 1)
    expect(sim.stops).toBe(1)
  })

  test('honours DeviceMessageTimingGap by coalescing, not dropping', async () => {
    const sim = startSim({ timingGap: 100 })
    const backend = makeBackend(sim.port)
    await backend.connect()
    await until(() => backend.targetIndex !== null)

    backend.move(0.1, 50)
    // Three more inside the gap: only the newest should survive, and it must
    // actually arrive — dropping it would strand the device at 0.1.
    backend.move(0.2, 50)
    backend.move(0.3, 50)
    backend.move(0.4, 50)

    await until(() => sim.moves.length >= 2, 1000)
    await wait(150)

    expect(sim.moves).toHaveLength(2)
    expect(sim.moves[0].position).toBeCloseTo(0.1, 6)
    expect(sim.moves[1].position).toBeCloseTo(0.4, 6)
  })

  test('moves before a device exists are dropped rather than throwing', async () => {
    const sim = startSim()
    const backend = makeBackend(sim.port)
    // Deliberately no connect().
    expect(() => backend.move(0.5, 200)).not.toThrow()
    expect(() => backend.stop()).not.toThrow()
    expect(sim.moves).toHaveLength(0)
  })

  test('tracks device removal and re-addition', async () => {
    const sim = startSim()
    const backend = makeBackend(sim.port)
    await backend.connect()
    await until(() => backend.targetIndex !== null)

    sim.setDevicePresent(false)
    await until(() => backend.devices.length === 0)
    expect(backend.targetIndex).toBeNull()

    // Moves while nothing is connected must be silently ignored.
    const before = sim.moves.length
    backend.move(0.5, 200)
    await wait(50)
    expect(sim.moves).toHaveLength(before)

    sim.setDevicePresent(true)
    await until(() => backend.targetIndex === 0)
    backend.move(0.5, 200)
    await until(() => sim.moves.length === before + 1)
  })

  test('reports an error for a server that is not there', async () => {
    const backend = makeBackend(47999) // nothing listening
    const details: string[] = []
    backend.on('state', (s, d) => {
      if (d) details.push(d)
    })
    await backend.connect()
    expect(backend.state).toBe('error')
    expect(details.join(' ')).toContain('Intiface Central')
  })

  test('disconnect() closes cleanly and stops driving', async () => {
    const sim = startSim()
    const backend = makeBackend(sim.port)
    await backend.connect()
    await until(() => backend.targetIndex !== null)

    backend.disconnect()
    await until(() => backend.state === 'disconnected')

    const before = sim.moves.length
    backend.move(0.7, 200)
    await wait(50)
    expect(sim.moves).toHaveLength(before)
  })

  test('a second connect() replaces the first session', async () => {
    const sim = startSim()
    const backend = makeBackend(sim.port)
    await backend.connect()
    await until(() => backend.targetIndex !== null)
    await backend.connect()
    await until(() => backend.targetIndex !== null)

    expect(backend.state).toBe('connected')
    backend.move(0.6, 300)
    await until(() => sim.moves.some((m) => m.position === 0.6))
  })
})
