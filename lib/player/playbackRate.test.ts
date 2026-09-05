/**
 * The ladder is read from three places that never see each other — the slider,
 * the settings form and the keyboard — so what is tested here is that they
 * cannot land on a rate the others have no position for, and that nothing
 * unmeasurable (a NaN out of an empty `<input>`, a missing settings key) leaks
 * through to `video.playbackRate`.
 */

import { describe, expect, test } from 'bun:test'

import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  NORMAL_PLAYBACK_RATE,
  PLAYBACK_RATES,
  RATE_RANGE,
  clampRate,
  formatRate,
  rateAt,
  rateIndex,
  stepRate,
} from './playbackRate'

describe('the ladder itself', () => {
  test('spans 0.25× to 4× and includes 1×', () => {
    expect(MIN_PLAYBACK_RATE).toBe(0.25)
    expect(MAX_PLAYBACK_RATE).toBe(4)
    expect(PLAYBACK_RATES).toContain(NORMAL_PLAYBACK_RATE)
  })

  test('ascends strictly, so an index comparison is a speed comparison', () => {
    for (let i = 1; i < PLAYBACK_RATES.length; i++) {
      expect(PLAYBACK_RATES[i]).toBeGreaterThan(PLAYBACK_RATES[i - 1])
    }
  })

  test('the slider bounds address every rung and nothing else', () => {
    expect(RATE_RANGE.min).toBe(0)
    expect(RATE_RANGE.max).toBe(PLAYBACK_RATES.length - 1)
    expect(RATE_RANGE.step).toBe(1)
  })
})

describe('clampRate', () => {
  test('leaves a rung alone', () => {
    for (const rate of PLAYBACK_RATES) expect(clampRate(rate)).toBe(rate)
  })

  test('snaps a value between rungs rather than passing it through', () => {
    // A hand-edited settings blob, or a rate saved before the ladder changed.
    expect(clampRate(1.9)).toBe(2)
    expect(clampRate(0.3)).toBe(0.25)
    expect(clampRate(2.9)).toBe(3)
  })

  test('pins out-of-range values to the ends', () => {
    expect(clampRate(16)).toBe(MAX_PLAYBACK_RATE)
    expect(clampRate(0.01)).toBe(MIN_PLAYBACK_RATE)
    expect(clampRate(-4)).toBe(MIN_PLAYBACK_RATE)
  })

  test('falls back to 1× for anything unmeasurable', () => {
    // `parseFloat('')` out of an empty input, and a key an older install has
    // never written.
    expect(clampRate(NaN)).toBe(NORMAL_PLAYBACK_RATE)
    expect(clampRate(undefined)).toBe(NORMAL_PLAYBACK_RATE)
    expect(clampRate('2')).toBe(NORMAL_PLAYBACK_RATE)
    expect(clampRate(Infinity)).toBe(NORMAL_PLAYBACK_RATE)
  })
})

describe('rateIndex / rateAt', () => {
  test('round-trip every rung through the slider position', () => {
    for (const rate of PLAYBACK_RATES) expect(rateAt(rateIndex(rate))).toBe(rate)
  })

  test('rateAt pins an index the slider could never produce', () => {
    expect(rateAt(-1)).toBe(MIN_PLAYBACK_RATE)
    expect(rateAt(99)).toBe(MAX_PLAYBACK_RATE)
    expect(rateAt(NaN)).toBe(NORMAL_PLAYBACK_RATE)
  })

  test('a tie goes to the slower rung', () => {
    // Exactly between 2 and 2.5 — the half-step gap is the only place a tie
    // can happen, and slowing down is the safer surprise.
    expect(rateAt(rateIndex(2.25))).toBe(2)
  })
})

describe('stepRate', () => {
  test('walks one rung at a time in both directions', () => {
    expect(stepRate(1, 1)).toBe(1.25)
    expect(stepRate(1, -1)).toBe(0.75)
    expect(stepRate(2, 1)).toBe(2.5)
  })

  test('stops at the ends instead of walking off', () => {
    expect(stepRate(MAX_PLAYBACK_RATE, 1)).toBe(MAX_PLAYBACK_RATE)
    expect(stepRate(MIN_PLAYBACK_RATE, -1)).toBe(MIN_PLAYBACK_RATE)
  })

  test('a between-rungs rate joins the ladder before stepping', () => {
    // 1.9 snaps to 2, so up is 2.5 rather than some 1.9-relative value.
    expect(stepRate(1.9, 1)).toBe(2.5)
  })
})

describe('formatRate', () => {
  test('drops trailing zeros', () => {
    expect(formatRate(1)).toBe('1×')
    expect(formatRate(2)).toBe('2×')
    expect(formatRate(1.5)).toBe('1.5×')
    expect(formatRate(1.25)).toBe('1.25×')
    expect(formatRate(0.25)).toBe('0.25×')
  })
})
