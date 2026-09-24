import { describe, expect, it } from 'bun:test'

import * as Q from './queue'
import { levelRange, nextStep, pickNext, waveCycle, type RadioCandidate } from './radio'

const shape = (tags: string[]) => waveCycle(tags).map((s) => `${s.phase}:${s.level}`)

const lib: RadioCandidate[] = [
  { _folder: 'e1', tags: ['easy', 'hypno'], durationSecs: 200 },
  { _folder: 'm1', tags: ['medium', 'hypno'], durationSecs: 200 },
  { _folder: 'h1', tags: ['hard', 'hypno', 'poppers'], durationSecs: 200 },
  { _folder: 'h2', tags: ['hard', 'pmv'], durationSecs: 200 },
  { _folder: 'x1', tags: ['extreme', 'hypno'], durationSecs: 200 },
  { _folder: 'lf', tags: ['hypno', 'long-form'], durationSecs: 5000 },
  { _folder: 'vol', tags: ['hypno', 'hard'], durationSecs: 5000 },
  { _folder: 'cal', tags: ['hypno', 'calibration'] },
]

describe('radio wave', () => {
  it('builds, plateaus, rests under the floor, then explodes', () => {
    expect(shape([])).toEqual(['build:0', 'build:1', 'build:2', 'plateau:2', 'rest:0', 'explosion:3'])
    expect(shape(['hard', 'extreme', 'hypno'])).toEqual([
      'build:2',
      'plateau:2',
      'rest:1',
      'explosion:3',
    ])
    expect(shape(['extreme'])).toEqual(['rest:2', 'explosion:3'])
  })

  it('steps on from the last radio row and wraps', () => {
    const four = waveCycle(['hard', 'extreme'])
    let q = Q.append(Q.EMPTY_QUEUE, { folder: 'a' }, 'a')
    expect(nextStep(q, four)).toBe(0)
    q = Q.append(q, { folder: 'b', radio: { phase: 'rest', level: 1, step: 3 } }, 'b')
    q = Q.append(q, { folder: 'c', tags: ['easy'] }, 'c')
    expect(nextStep(q, four)).toBe(0)
    expect(nextStep(q, waveCycle([]))).toBe(4)
  })

  it('a fresh wave joins at the level that just played', () => {
    const full = waveCycle([]) // build e, m, h | plateau h | rest e | explosion x
    expect(nextStep(Q.EMPTY_QUEUE, full)).toBe(0)
    expect(nextStep(Q.EMPTY_QUEUE, full, ['pmv'])).toBe(0)
    expect(nextStep(Q.EMPTY_QUEUE, full, ['hard'])).toBe(2)
    // Already at the top: breathe first.
    expect(nextStep(Q.EMPTY_QUEUE, full, ['hard', 'extreme'])).toBe(4)
    // The queue's current item stands in when no video is named.
    const q = Q.setCurrent(Q.append(Q.EMPTY_QUEUE, { folder: 'a', tags: ['medium'] }, 'a'), 'a')
    expect(nextStep(q, full)).toBe(1)
    // Hard only has no climb, so it rests at medium before exploding.
    expect(nextStep(Q.EMPTY_QUEUE, waveCycle(['hard']), ['hard'])).toBe(0)
  })

  it('reads a range from several difficulty tags', () => {
    expect(levelRange(['medium', 'hard'])).toEqual([1, 2])
    expect(levelRange(['pmv'])).toBeNull()
  })
})

describe('radio pick', () => {
  const settings = (tags: string[]) => ({ enabled: true, tags })

  it('keeps to the taste, skips calibration and unasked long videos', () => {
    for (let i = 0; i < 50; i++) {
      const p = pickNext(Q.EMPTY_QUEUE, settings(['hypno']), lib, () => i / 50)
      expect(['e1', 'm1', 'h1', 'x1']).toContain(p!.video.folder)
    }
  })

  it('lands on the step level when one is there', () => {
    // hard..extreme starts with build at hard; the only hard hypno is h1.
    const p = pickNext(Q.EMPTY_QUEUE, settings(['hard', 'extreme', 'hypno']), lib, () => 0.5)
    expect(p!.video.folder).toBe('h1')
    expect(p!.mark).toEqual({ phase: 'build', level: 2, step: 0 })
  })

  it('a rest finds the one medium video among many hard ones', () => {
    const many: RadioCandidate[] = [
      ...Array.from({ length: 30 }, (_, i) => ({ _folder: `h${i}`, tags: ['hard', 'poppers'] })),
      { _folder: 'mid', tags: ['medium', 'poppers'] },
    ]
    // hard..extreme: build, plateau, then rest at medium (step 2).
    const q = Q.append(Q.EMPTY_QUEUE, { folder: 'h0', radio: { phase: 'plateau', level: 2, step: 1 } })
    for (let i = 0; i < 20; i++) {
      const p = pickNext(q, settings(['hard', 'extreme', 'poppers']), many, () => i / 20)
      expect(p!.video.folder).toBe('mid')
      expect(p!.mark.phase).toBe('rest')
    }
  })

  it('does not replay a recent video while others are left', () => {
    const q = Q.append(Q.EMPTY_QUEUE, { folder: 'h1' }, 'h1')
    const p = pickNext(q, settings(['hard', 'extreme', 'hypno']), lib, () => 0.5)
    expect(p!.video.folder).not.toBe('h1')
  })

  it('returns null when nothing shares the taste', () => {
    expect(pickNext(Q.EMPTY_QUEUE, settings(['furry']), lib)).toBeNull()
  })
})
