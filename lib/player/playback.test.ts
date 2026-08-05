/**
 * The "what plays next" decision, which is the part with real branches: a
 * per-track repeat has to outrank the playlist mode, `once` has to stop after
 * exactly one extra play, and the end of a shuffled list has to wrap only when
 * the user asked for repeat-all.
 */

import { describe, expect, test } from 'bun:test'
import {
  advance,
  cycleLoopMode,
  cyclePlaylistLoopMode,
  sequentialOrder,
  shuffledOrder,
  type AdvanceInput,
} from './playback'

const base: AdvanceInput = {
  order: [0, 1, 2],
  position: 0,
  loop: 'off',
  trackLoop: 'off',
  repeatsUsed: 0,
}

describe('advance', () => {
  test('walks the order and then stops', () => {
    expect(advance(base)).toEqual({ action: 'next', position: 1, wrapped: false })
    expect(advance({ ...base, position: 2 })).toEqual({ action: 'stop' })
  })

  test('wraps at the end only with loop: all', () => {
    expect(advance({ ...base, position: 2, loop: 'all' })).toEqual({
      action: 'next',
      position: 0,
      wrapped: true,
    })
  })

  test('loop: one pins the current track', () => {
    expect(advance({ ...base, loop: 'one' })).toEqual({ action: 'repeat' })
  })

  test('trackLoop: forever never advances', () => {
    expect(
      advance({ ...base, trackLoop: 'forever', repeatsUsed: 99, loop: 'all' }),
    ).toEqual({ action: 'repeat' })
  })

  test('trackLoop: once gives exactly one extra play', () => {
    expect(advance({ ...base, trackLoop: 'once' })).toEqual({ action: 'repeat' })
    expect(advance({ ...base, trackLoop: 'once', repeatsUsed: 1 })).toEqual({
      action: 'next',
      position: 1,
      wrapped: false,
    })
  })

  test('a spent trackLoop: once still stops at the end of a non-looping list', () => {
    expect(
      advance({ ...base, position: 2, trackLoop: 'once', repeatsUsed: 1 }),
    ).toEqual({ action: 'stop' })
  })

  test('an empty order stops rather than wrapping onto nothing', () => {
    expect(advance({ ...base, order: [], position: 0, loop: 'all' })).toEqual({
      action: 'stop',
    })
  })
})

describe('shuffledOrder', () => {
  test('is a permutation of every index', () => {
    const order = shuffledOrder(50)
    expect(order.length).toBe(50)
    expect([...order].sort((a, b) => a - b)).toEqual(sequentialOrder(50))
  })

  test('pins the requested index to the front', () => {
    for (let seed = 0; seed < 20; seed++) {
      const order = shuffledOrder(8, 5, () => (seed * 0.137) % 1)
      expect(order[0]).toBe(5)
      expect([...order].sort((a, b) => a - b)).toEqual(sequentialOrder(8))
    }
  })

  test('ignores a pin that is not in range', () => {
    expect(shuffledOrder(3, 9).length).toBe(3)
  })
})

describe('mode cycling', () => {
  test('loops back round', () => {
    expect(cycleLoopMode('off')).toBe('once')
    expect(cycleLoopMode('once')).toBe('forever')
    expect(cycleLoopMode('forever')).toBe('off')
    expect(cyclePlaylistLoopMode('off')).toBe('all')
    expect(cyclePlaylistLoopMode('all')).toBe('one')
    expect(cyclePlaylistLoopMode('one')).toBe('off')
  })
})
