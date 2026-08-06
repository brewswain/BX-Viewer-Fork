/**
 * The "what plays next" decision, which is the part with real branches: a
 * per-track repeat has to outrank the playlist mode, `once` has to stop after
 * exactly one extra play, and the end of a shuffled list has to wrap only when
 * the user asked for repeat-all.
 */

import { describe, expect, test } from 'bun:test'
import {
  advance,
  barLoopMode,
  cycleBarLoop,
  cycleLoopMode,
  cyclePlaylistLoopMode,
  cycleRowLoop,
  rowLoopMode,
  sequentialOrder,
  shuffledOrder,
  type AdvanceInput,
  type PlaylistPrefs,
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

/**
 * The control bar and the playing track's sidebar row must never disagree:
 * "repeat this video" is one fact reachable from either, so each round trip
 * through the other control has to land somewhere both of them read the same.
 */
describe('shared loop state', () => {
  const prefs = (over: Partial<PlaylistPrefs> = {}): PlaylistPrefs => ({
    loop: 'off',
    shuffle: false,
    tracks: {},
    ...over,
  })

  test('the bar reflects a ∞ pinned on the playing row', () => {
    expect(barLoopMode(prefs({ tracks: { a: 'forever' } }), 'a')).toBe('one')
    // Another track's ∞ is not the playing track's, and +1 is row-only.
    expect(barLoopMode(prefs({ tracks: { b: 'forever' } }), 'a')).toBe('off')
    expect(barLoopMode(prefs({ tracks: { a: 'once' } }), 'a')).toBe('off')
  })

  test('a playlist mode outranks the derived one', () => {
    expect(barLoopMode(prefs({ loop: 'all', tracks: { a: 'forever' } }), 'a')).toBe(
      'all',
    )
  })

  test('the playing row reflects repeat-one, other rows do not', () => {
    expect(rowLoopMode(prefs({ loop: 'one' }), 'a', 'a')).toBe('forever')
    expect(rowLoopMode(prefs({ loop: 'one' }), 'b', 'a')).toBe('off')
  })

  test('the bar cycles off → all → one → off', () => {
    const off = prefs()
    const all = cycleBarLoop(off, 'a')
    expect(all.loop).toBe('all')
    const one = cycleBarLoop(all, 'a')
    expect(one.loop).toBe('one')
    expect(rowLoopMode(one, 'a', 'a')).toBe('forever')
    const back = cycleBarLoop(one, 'a')
    expect(barLoopMode(back, 'a')).toBe('off')
  })

  test('the bar releases a row ∞ instead of deriving it straight back', () => {
    // Bar shows `one` because the row is pinned; pressing it must reach `off`.
    const pinned = prefs({ tracks: { a: 'forever' } })
    const next = cycleBarLoop(pinned, 'a')
    expect(barLoopMode(next, 'a')).toBe('off')
    expect(rowLoopMode(next, 'a', 'a')).toBe('off')
  })

  test('taking the playing row off ∞ clears repeat-one', () => {
    const one = prefs({ loop: 'one' })
    const next = cycleRowLoop(one, 'a', 'a')
    expect(next.loop).toBe('off')
    expect(barLoopMode(next, 'a')).toBe('off')
    expect(rowLoopMode(next, 'a', 'a')).toBe('off')
  })

  test('a row ∞ lights the bar, and +1 stays row-only', () => {
    const once = cycleRowLoop(prefs(), 'a', 'a')
    expect(rowLoopMode(once, 'a', 'a')).toBe('once')
    expect(barLoopMode(once, 'a')).toBe('off')
    const forever = cycleRowLoop(once, 'a', 'a')
    expect(rowLoopMode(forever, 'a', 'a')).toBe('forever')
    expect(barLoopMode(forever, 'a')).toBe('one')
  })

  test('other rows stay independent of the bar', () => {
    const one = prefs({ loop: 'one', tracks: { b: 'once' } })
    const next = cycleRowLoop(one, 'b', 'a')
    expect(next.loop).toBe('one')
    expect(rowLoopMode(next, 'b', 'a')).toBe('forever')
    expect(rowLoopMode(next, 'a', 'a')).toBe('forever')
  })

  test('repeat-one and a row ∞ agree with what advance() does', () => {
    for (const p of [prefs({ loop: 'one' }), prefs({ tracks: { a: 'forever' } })]) {
      expect(rowLoopMode(p, 'a', 'a')).toBe('forever')
      expect(
        advance({
          ...base,
          loop: p.loop,
          trackLoop: p.tracks.a || 'off',
        }),
      ).toEqual({ action: 'repeat' })
    }
  })
})
