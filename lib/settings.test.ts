import { describe, expect, test } from 'bun:test'
import { clampSauceRange, deviceConfigFromSettings, DEFAULTS } from './settings'

describe('clampSauceRange', () => {
  const r = (lo: number, hi: number) => {
    const s = clampSauceRange(lo, hi)
    return [s.deviceFitSauceMinPct, s.deviceFitSauceMaxPct]
  }

  test('keeps a valid range, at 0.1 resolution', () => {
    expect(r(0, 58.3)).toEqual([0, 58.3])
    expect(r(12.34, 58.36)).toEqual([12.3, 58.4])
  })

  test('clamps both ends to 0..100', () => {
    expect(r(-5, 140)).toEqual([0, 100])
  })

  test('swaps a range entered backwards', () => {
    expect(r(60, 10)).toEqual([10, 60])
  })

  test('widens an empty range instead of zeroing the travel', () => {
    expect(r(40, 40)).toEqual([40, 40.1])
    expect(r(100, 100)).toEqual([99.9, 100])
  })
})

test('the Sauce range reaches the device config', () => {
  const c = deviceConfigFromSettings({
    ...DEFAULTS,
    deviceFitSauceMinPct: 0,
    deviceFitSauceMaxPct: 58.3,
  })
  expect(c.fitSauceMinPct).toBe(0)
  expect(c.fitSauceMaxPct).toBe(58.3)
})
