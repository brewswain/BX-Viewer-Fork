/**
 * The bench recorder, and the driver's side of it.
 *
 * These pin the two things that would make a bench session worthless without
 * anybody noticing at the time: a log that does not name its own `minCmdMs`,
 * and a log that cannot be lined up against the burnt-in frame number on the
 * card. Everything else here is ordinary.
 */

import { describe, expect, test } from 'bun:test'
import { BenchRecorder, frameOf, MAX_ENTRIES, type BenchEntry } from './bench'
import { StrokeDriver, type StrokePlan } from './driver'
import { buildStrokePlan } from './plan'
import { FPS } from '@/lib/player/constants'
import {
  Emitter,
  type ConnectionState,
  type DeviceBackend,
  type DeviceInfo,
  type EaseHint,
} from './types'

class FakeBackend extends Emitter implements DeviceBackend {
  readonly kind = 'buttplug' as const
  readonly devices: DeviceInfo[] = []
  readonly state: ConnectionState = 'connected'
  moves: { pos: number; dur: number }[] = []
  async connect(): Promise<void> {}
  disconnect(): void {}
  move(pos: number, dur: number, _hint?: EaseHint): void {
    this.moves.push({ pos, dur })
  }
  stop(): void {}
}

const header = (minCmdMs = 100) => ({
  startedAt: '2026-09-29T00:00:00.000Z',
  minCmdMs,
  leadMs: 0,
  offsetMs: 0,
  rangeMin: 0,
  rangeMax: 1,
  invert: false,
  backend: 'ossm',
  planCommands: 4,
  label: 'bench-card',
  fps: FPS,
  governorLevel: 'tame',
  capsHash: 'deadbeef',
  fit: { maxSpeed: 20113, maxAccel: 500000, travelSteps: 3381.4, sauceMinPct: 0, sauceMaxPct: 58.3 },
})

const entry = (over: Partial<BenchEntry> = {}): BenchEntry => ({
  frame: 0,
  videoMs: 0,
  cmdMs: 0,
  pos: 0.5,
  dur: 100,
  kind: 'cmd',
  merged: 0,
  lateMs: 0,
  seek: false,
  ...over,
})

describe('BenchRecorder', () => {
  test('records nothing until armed', () => {
    const r = new BenchRecorder()
    r.record(entry())
    expect(r.count()).toBe(0)
    expect(r.isArmed()).toBe(false)
  })

  test('arming clears whatever the last run left behind', () => {
    const r = new BenchRecorder()
    r.arm(header())
    r.record(entry())
    expect(r.count()).toBe(1)
    r.arm(header())
    expect(r.count()).toBe(0)
  })

  test('disarming keeps the entries, so the CSV can still be saved', () => {
    const r = new BenchRecorder()
    r.arm(header())
    r.record(entry())
    r.disarm()
    r.record(entry())
    expect(r.count()).toBe(1)
  })

  test('the CSV header names minCmdMs, which is what makes a run readable', () => {
    const r = new BenchRecorder()
    r.arm(header(20))
    const csv = r.toCsv()
    expect(csv).toContain('minCmdMs=20')
    expect(csv).toContain('frame,videoMs,cmdMs,pos,dur,kind,merged,lateMs,seek')
  })

  test('the CSV header records the fit: caps, Sauce range and derived travel', () => {
    const r = new BenchRecorder()
    r.arm(header())
    expect(r.toCsv()).toContain(
      '# fit=on  maxSpeed=20113  maxAccel=500000  sauceMinPct=0  sauceMaxPct=58.3  travelSteps=3381',
    )
    r.arm({ ...header(), fit: null })
    expect(r.toCsv()).toContain('# fit=off')
  })

  test('an unarmed log says so instead of looking like a run at the default', () => {
    const csv = new BenchRecorder().toCsv()
    expect(csv).toContain('NO HEADER')
    expect(csv).not.toContain('minCmdMs=')
  })

  test('an anchor writes an empty cmdMs rather than a zero', () => {
    const r = new BenchRecorder()
    r.arm(header())
    r.record(entry({ kind: 'anchor', cmdMs: null, frame: 7 }))
    const row = r.toCsv().trim().split('\n').at(-1)!
    expect(row.split(',')[2]).toBe('')
    expect(row.split(',')[5]).toBe('anchor')
  })

  test('overflow is flagged in the file rather than silently dropped', () => {
    const r = new BenchRecorder()
    r.arm(header())
    // Reach into the bound rather than pushing 200k objects.
    for (let i = 0; i < 5; i++) r.record(entry())
    expect(r.didOverflow()).toBe(false)
    expect(MAX_ENTRIES).toBeGreaterThan(19_869) // the bench path's frame count
  })
})

describe('frameOf', () => {
  test('is the card frame, not seconds', () => {
    expect(frameOf(0)).toBe(0)
    expect(frameOf(1000)).toBe(FPS)
    expect(frameOf(16.7)).toBe(1)
  })
})

describe('StrokeDriver with a recorder attached', () => {
  // Markers every 6 frames, alternating, so the plan is a command about every
  // 100 ms rather than two long linear ramps. A sparse plan cannot show the
  // collapse this file exists to record.
  const plan = (): StrokePlan =>
    buildStrokePlan(
      Array.from({ length: 21 }, (_, i) => ({
        frame: i * 6,
        depth: i % 2,
        trans: 0,
        ease: 0,
      })),
      { minCmdMs: 100, maxCmdMs: 1000, tolerance: 0.04 },
    )

  function rig() {
    const backend = new FakeBackend()
    const rec = new BenchRecorder()
    rec.arm(header())
    const d = new StrokeDriver()
    d.setBackend(backend)
    d.setPlan(plan())
    d.setRecorder(rec)
    d.setRunning(true)
    return { backend, rec, d }
  }

  test('every issued move lands in the log, keyed to the video frame', () => {
    const { backend, rec, d } = rig()
    d.tick(0, true)
    d.tick(500, true)
    expect(rec.count()).toBe(backend.moves.length)
    const rows = rec.snapshot().entries
    // 500 ms of video at 60 fps is frame 30, which is the number on the card.
    expect(rows.at(-1)!.frame).toBe(frameOf(500))
  })

  test('the first frame is marked as a seek, because it re-anchors', () => {
    const { rec, d } = rig()
    d.tick(0, true)
    expect(rec.snapshot().entries[0].seek).toBe(true)
  })

  test('a jump forward logs the collapse rather than hiding it', () => {
    const { rec, d } = rig()
    // Through the opening catch-up glide, which an unknown position makes the
    // full 1.5 s, and onto the path proper.
    for (let t = 0; t <= 1504; t += 16) d.tick(t, true)
    // Land well past several due commands without tripping the seek threshold,
    // so they collapse into one move: that is the fall-behind case, and on the
    // rail it looks exactly like a machine that could not keep up.
    d.tick(1744, true)
    const last = rec.snapshot().entries.at(-1)!
    expect(last.merged).toBeGreaterThan(0)
    expect(last.lateMs).toBeGreaterThan(0)
  })

  test('a driver with no recorder still runs', () => {
    const backend = new FakeBackend()
    const d = new StrokeDriver()
    d.setBackend(backend)
    d.setPlan(plan())
    d.setRunning(true)
    d.tick(0, true)
    expect(backend.moves.length).toBe(1)
  })

  test('the counters the HUD reads move with the log', () => {
    const { rec, d } = rig()
    for (let t = 0; t <= 1504; t += 16) d.tick(t, true)
    d.tick(1744, true)
    expect(d.stats.sent).toBe(rec.count())
    expect(d.stats.lastMerged).toBe(rec.snapshot().entries.at(-1)!.merged)
  })
})
