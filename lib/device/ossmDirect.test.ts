/**
 * Transport tests for the MCP route, against a stand-in for OSSM Sauce's
 * command server.
 *
 * The thing worth testing here is not the HTTP — it is the ten bytes. That
 * frame is handed to the ESP32 with nothing in between to correct it, so field
 * order, endianness and the 0..10000 depth scale have to be exactly right, and
 * a mistake would show up as the machine doing something wrong rather than as
 * an error anywhere.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { OssmDirectBackend } from './ossmDirect'

declare const Bun: {
  serve(opts: {
    port: number
    fetch(req: Request): Response | Promise<Response>
  }): { port: number; stop(closeActive?: boolean): void }
}

type Frame = {
  cmd: number
  durMs: number
  depth: number
  trans: number
  ease: number
  aux: number
}

type Sim = {
  readonly port: number
  readonly frames: Frame[]
  statusCalls: number
  /** Flipped to model the OSSM dropping off while the app stays up. */
  ossmConnected: boolean
  /** Holds requests open, to create a real in-flight window for coalescing. */
  stall: boolean
  stop(): void
}

let nextPort = 47410
const sims: Sim[] = []
const backends: OssmDirectBackend[] = []

function startSim(): Sim {
  // `sim` is the shared mutable state, not a copy of it — the handler closes
  // over the same object the test mutates.
  const sim: Sim = {
    port: nextPort++,
    frames: [],
    statusCalls: 0,
    ossmConnected: true,
    stall: false,
    stop: () => {},
  }

  const server = Bun.serve({
    port: sim.port,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method !== 'POST') return new Response('nope', { status: 405 })

      if (url.pathname === '/status') {
        sim.statusCalls++
        return Response.json({
          websocket_listening: true,
          connected_clients: sim.ossmConnected ? 1 : 0,
          server_started: true,
          ossm_connected: sim.ossmConnected,
          has_mcp_server: true,
        })
      }

      if (url.pathname === '/send_binary') {
        const body = (await req.json()) as { hex_data?: string }
        const hex = body.hex_data ?? ''
        const bytes = new Uint8Array(
          (hex.match(/../g) ?? []).map((h) => parseInt(h, 16)),
        )
        if (sim.stall) await new Promise((r) => setTimeout(r, 60))
        const view = new DataView(bytes.buffer)
        ;(sim.frames as Frame[]).push({
          cmd: view.getUint8(0),
          durMs: view.getUint32(1, true),
          depth: view.getUint16(5, true),
          trans: view.getUint8(7),
          ease: view.getUint8(8),
          aux: view.getUint8(9),
        })
        return Response.json({ status: 'sent', bytes: bytes.length })
      }

      return new Response('not found', { status: 404 })
    },
  })

  sim.stop = () => server.stop(true)
  sims.push(sim)
  return sim
}

function makeBackend(port: number) {
  const b = new OssmDirectBackend({ url: `http://127.0.0.1:${port}` })
  backends.push(b)
  return b
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await wait(5)
  }
  throw new Error('condition not met in time')
}

afterEach(() => {
  for (const b of backends.splice(0)) b.disconnect()
  for (const s of sims.splice(0)) s.stop()
})

describe('OssmDirectBackend', () => {
  test('connects when the MCP server answers /status', async () => {
    const sim = startSim()
    const b = makeBackend(sim.port)

    await b.connect()

    expect(b.state).toBe('connected')
    expect(sim.statusCalls).toBeGreaterThan(0)
  })

  test('reports the OSSM as a device only when the app says it is attached', async () => {
    const sim = startSim()
    sim.ossmConnected = false
    const b = makeBackend(sim.port)

    await b.connect()

    // Reachable bridge, absent machine: connected, but nothing to drive. This
    // is the failure the XToys route cannot see at all.
    expect(b.state).toBe('connected')
    expect(b.devices).toHaveLength(0)
  })

  test('fails with an actionable message when nothing is listening', async () => {
    const b = makeBackend(47999)
    const details: string[] = []
    b.on('state', (_s, detail) => detail && details.push(detail))

    await b.connect()

    expect(b.state).toBe('error')
    expect(details.join(' ')).toContain('MCP')
  })

  test('encodes SMOOTH_MOVE the way the firmware reads it', async () => {
    const sim = startSim()
    const b = makeBackend(sim.port)
    await b.connect()

    b.move(0.25, 240)
    await until(() => sim.frames.length === 1)

    const f = sim.frames[0]
    expect(f.cmd).toBe(0x0f) // SMOOTH_MOVE
    expect(f.durMs).toBe(240) // u32 little-endian
    expect(f.depth).toBe(2500) // 0..1 → 0..10000
    expect(f.trans).toBe(0) // TRANS_LINEAR — never the app's Sine
    expect(f.ease).toBe(0)
    expect(f.aux).toBe(0)
  })

  test('clamps position to the full-scale range', async () => {
    const sim = startSim()
    const b = makeBackend(sim.port)
    await b.connect()

    b.move(1.4, 100)
    await until(() => sim.frames.length === 1)
    b.move(-0.3, 100)
    await until(() => sim.frames.length === 2)

    expect(sim.frames[0].depth).toBe(10000)
    expect(sim.frames[1].depth).toBe(0)
  })

  test('respects the firmware 20 ms duration floor', async () => {
    const sim = startSim()
    const b = makeBackend(sim.port)
    await b.connect()

    b.move(0.5, 3)
    await until(() => sim.frames.length === 1)

    expect(sim.frames[0].durMs).toBe(20)
  })

  test('coalesces to the newest move rather than queueing a backlog', async () => {
    const sim = startSim()
    const b = makeBackend(sim.port)
    await b.connect()

    sim.stall = true
    b.move(0.1, 100) // goes out immediately
    b.move(0.2, 100) // superseded while the first is open
    b.move(0.3, 100) // ...and so is that one
    sim.stall = false

    await until(() => sim.frames.length === 2)
    await wait(80)

    // Two frames, not three: the middle position was dropped on purpose.
    expect(sim.frames).toHaveLength(2)
    expect(sim.frames[0].depth).toBe(1000)
    expect(sim.frames[1].depth).toBe(3000)
  })

  test('sends nothing before connecting or after disconnecting', async () => {
    const sim = startSim()
    const b = makeBackend(sim.port)

    b.move(0.5, 100)
    await wait(30)
    expect(sim.frames).toHaveLength(0)

    await b.connect()
    b.disconnect()
    b.move(0.5, 100)
    await wait(30)

    expect(sim.frames).toHaveLength(0)
    expect(b.state).toBe('disconnected')
  })

  test('a dead move never rejects on the render path', async () => {
    const sim = startSim()
    const b = makeBackend(sim.port)
    await b.connect()
    sim.stop()

    // The driver calls this from rAF; throwing here would take out playback.
    expect(() => b.move(0.5, 100)).not.toThrow()
    await wait(50)
  })
})
