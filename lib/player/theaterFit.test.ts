/**
 * The fit runs on every resize and every track change, against whatever the
 * browser reports — including a box of zero height mid-transition and a video
 * whose metadata has not arrived. Those have to come back as identity, because
 * the alternative is a NaN reaching `transform` and blanking the picture.
 */

import { describe, expect, test } from 'bun:test'

import {
  MAX_STRETCH,
  MAX_ZOOM,
  STRETCH_RANGE,
  ZOOM_RANGE,
  clampStretch,
  clampZoom,
  fitTransform,
  theaterFit,
} from './theaterFit'

const IDENTITY_CHECK = { scaleX: 1, scaleY: 1 }

/** Effective width multiple: how much of the pillarbox gap the fit closed. */
function closed(boxW: number, boxH: number, vidW: number, vidH: number) {
  const fit = theaterFit(boxW, boxH, vidW, vidH)
  return fit.scaleX / fit.scaleY
}

describe('theaterFit', () => {
  test('leaves a picture that already spans the box alone', () => {
    // 16:9 video in a 16:9 box, and in a box taller than it.
    expect(theaterFit(1920, 1080, 1920, 1080)).toEqual({ scaleX: 1, scaleY: 1 })
    expect(theaterFit(1000, 1000, 1920, 1080)).toEqual({ scaleX: 1, scaleY: 1 })
  })

  test('stretches first, without cropping, while the gap is small', () => {
    // A 10% gap is under the stretch cap, so nothing needs to be zoomed away.
    const fit = theaterFit(1920 * 1.1, 1080, 1920, 1080)
    expect(fit.scaleY).toBe(1)
    expect(fit.scaleX).toBeCloseTo(1.1, 4)
  })

  test('zooms only once the stretch is capped', () => {
    // Caps passed explicitly: the shipped MAX_ZOOM is 1, so the defaults can no
    // longer show the ordering this asserts — stretch spends itself first, and
    // only what it cannot close falls through to zoom.
    // 16:9 in a 2.4:1 stage — a 1.35 gap, past what stretch alone may close.
    const fit = theaterFit(2400, 1000, 1920, 1080, { maxZoom: 1.05 })
    expect(fit.scaleY).toBeGreaterThan(1)
    expect(fit.scaleX / fit.scaleY).toBeCloseTo(MAX_STRETCH, 4)
  })

  test('never warps or crops past the caps', () => {
    // An absurd stage: both moves pin, and the rest stays as bars.
    const fit = theaterFit(10_000, 1000, 1920, 1080)
    expect(fit.scaleY).toBeCloseTo(MAX_ZOOM, 4)
    expect(fit.scaleX).toBeCloseTo(MAX_STRETCH * MAX_ZOOM, 4)
  })

  test('closes the gap exactly when the caps allow it', () => {
    const gap = MAX_STRETCH * MAX_ZOOM // the widest gap the caps can close
    const fit = theaterFit(1920 * gap, 1080, 1920, 1080)
    expect(fit.scaleX).toBeCloseTo(gap, 4)
  })

  test('honours caller-supplied caps', () => {
    const off = theaterFit(3000, 1000, 1920, 1080, { maxStretch: 1, maxZoom: 1 })
    expect(off).toEqual({ scaleX: 1, scaleY: 1 })
    const stretchOnly = theaterFit(3000, 1000, 1920, 1080, { maxZoom: 1 })
    expect(stretchOnly.scaleY).toBe(1)
    expect(stretchOnly.scaleX).toBeCloseTo(MAX_STRETCH, 4)
  })

  test('a wider gap is never closed by less warp than a narrower one', () => {
    expect(closed(2200, 1000, 1920, 1080)).toBeGreaterThanOrEqual(
      closed(2000, 1000, 1920, 1080),
    )
  })

  test('leaves portrait video alone however wide the stage', () => {
    expect(theaterFit(2400, 1000, 1080, 1920)).toEqual(IDENTITY_CHECK)
    // A square one is not portrait, and is fair game.
    expect(theaterFit(2400, 1000, 1000, 1000).scaleX).toBeGreaterThan(1)
  })

  test('is identity for anything unmeasurable', () => {
    expect(theaterFit(1920, 800, 0, 0)).toEqual(IDENTITY_CHECK) // metadata not in
    expect(theaterFit(1920, 0, 1920, 1080)).toEqual(IDENTITY_CHECK) // mid-transition
    expect(theaterFit(NaN, 800, 1920, 1080)).toEqual(IDENTITY_CHECK)
    expect(theaterFit(-100, 800, 1920, 1080)).toEqual(IDENTITY_CHECK)
  })
})

/**
 * The caps arrive from two places that can both hand over rubbish: a slider's
 * `parseFloat` (NaN on an empty value) and a settings blob written by an older
 * build, which simply has no such key. Either one reaching `theaterFit` unclamped
 * is a NaN transform and a blank picture.
 */
describe('cap clamping', () => {
  test('falls back to the shipped default for anything unusable', () => {
    for (const bad of [undefined, null, NaN, 'wide', {}]) {
      expect(clampStretch(bad)).toBe(MAX_STRETCH)
      expect(clampZoom(bad)).toBe(MAX_ZOOM)
    }
  })

  test('holds values inside the range the controls offer', () => {
    expect(clampStretch(99)).toBe(STRETCH_RANGE.max)
    expect(clampStretch(0.2)).toBe(STRETCH_RANGE.min)
    expect(clampZoom(99)).toBe(ZOOM_RANGE.max)
    expect(clampZoom(-1)).toBe(ZOOM_RANGE.min)
  })

  test('passes an in-range value through untouched', () => {
    expect(clampStretch(1.42)).toBe(1.42)
    expect(clampZoom(1.1)).toBe(1.1)
  })

  test('the shipped defaults are themselves in range', () => {
    expect(clampStretch(MAX_STRETCH)).toBe(MAX_STRETCH)
    expect(clampZoom(MAX_ZOOM)).toBe(MAX_ZOOM)
  })
})

describe('fitTransform', () => {
  test('is empty for identity, so the style can be cleared', () => {
    expect(fitTransform({ scaleX: 1, scaleY: 1 })).toBe('')
  })

  test('renders both axes', () => {
    expect(fitTransform({ scaleX: 1.2, scaleY: 1.1 })).toBe('scale(1.2000, 1.1000)')
  })
})
