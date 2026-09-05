import { describe, expect, test } from 'bun:test'

import { MARKER_OVERSCAN, markerWindow } from './markerWindow'

/** The measured pitch of a `.marker-list-item` at the default root size. */
const PITCH = 36.6
/** `.marker-list` is `max-height: 340px`, so about nine rows are on screen. */
const VIEW = 340
/** `longform7-full.bx`, the list this exists for. */
const LONGFORM = 21053

describe('markerWindow', () => {
  test('renders a screenful plus overscan, not the whole path', () => {
    const { start, end } = markerWindow(0, VIEW, LONGFORM, PITCH)
    expect(start).toBe(0)
    // 340/36.6 is 9.3, so ten rows touch the scrollport; the +1 for the
    // partial row at the far edge makes eleven, then the trailing overscan.
    expect(end).toBe(11 + MARKER_OVERSCAN)
    expect(end - start).toBeLessThan(30)
  })

  test('follows the scroll, keeping overscan on both sides', () => {
    const { start, end } = markerWindow(500 * PITCH, VIEW, LONGFORM, PITCH)
    expect(start).toBe(500 - MARKER_OVERSCAN)
    expect(end).toBe(500 + 11 + MARKER_OVERSCAN)
  })

  test('clamps at both ends rather than running off the list', () => {
    expect(markerWindow(0, VIEW, LONGFORM, PITCH).start).toBe(0)
    const bottom = markerWindow(LONGFORM * PITCH, VIEW, LONGFORM, PITCH)
    expect(bottom.end).toBe(LONGFORM)
    expect(bottom.start).toBeLessThan(LONGFORM)
    // A scroll position past the end cannot invert the window.
    const past = markerWindow(1e9, VIEW, LONGFORM, PITCH)
    expect(past.start).toBeLessThanOrEqual(past.end)
    expect(past.end).toBe(LONGFORM)
  })

  test('an empty list windows to nothing', () => {
    expect(markerWindow(0, VIEW, 0, PITCH)).toEqual({ start: 0, end: 0 })
  })

  test('a short list is rendered whole', () => {
    expect(markerWindow(0, VIEW, 12, PITCH)).toEqual({ start: 0, end: 12 })
  })

  test('an unmeasurable pitch falls back to rendering everything', () => {
    // Degrading to the old behaviour is right; an empty panel is not.
    expect(markerWindow(0, VIEW, 400, 0)).toEqual({ start: 0, end: 400 })
    expect(markerWindow(0, VIEW, 400, NaN)).toEqual({ start: 0, end: 400 })
    expect(markerWindow(0, VIEW, 400, -5)).toEqual({ start: 0, end: 400 })
  })

  test('an unmeasured viewport still renders rows', () => {
    // The panel has not been measured yet on the first paint.
    const { start, end } = markerWindow(0, 0, LONGFORM, PITCH)
    expect(start).toBe(0)
    expect(end).toBeGreaterThan(0)
  })

  test('shrugs off a bounce-scrolled negative offset', () => {
    expect(markerWindow(-120, VIEW, LONGFORM, PITCH).start).toBe(0)
  })
})
