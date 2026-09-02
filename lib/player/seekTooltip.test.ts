import { describe, expect, test } from 'bun:test'

import {
  clampTooltipCenter,
  formatSeekTime,
  formatTimeDisplay,
} from './seekTooltip'

/** The long-form session, the reason both readouts need an hours field. */
const LONGFORM = 101 * 60 + 6

describe('formatSeekTime', () => {
  test('reads mm:ss under an hour', () => {
    expect(formatSeekTime(0, 600)).toBe('00:00')
    expect(formatSeekTime(9, 600)).toBe('00:09')
    expect(formatSeekTime(75, 600)).toBe('01:15')
    expect(formatSeekTime(599, 600)).toBe('09:59')
  })

  test('reads h:mm:ss once the media is an hour or longer', () => {
    const ninetySix = 96 * 60
    expect(formatSeekTime(0, ninetySix)).toBe('0:00:00')
    expect(formatSeekTime(12, ninetySix)).toBe('0:00:12')
    expect(formatSeekTime(3661, ninetySix)).toBe('1:01:01')
    expect(formatSeekTime(ninetySix, ninetySix)).toBe('1:36:00')
  })

  test('the hours field follows the duration, not the hovered position', () => {
    // Exactly one hour still gets the field; a second short of it does not.
    expect(formatSeekTime(30, 3600)).toBe('0:00:30')
    expect(formatSeekTime(30, 3599)).toBe('00:30')
  })

  test('survives a duration the browser has not reported yet', () => {
    expect(formatSeekTime(0)).toBe('00:00')
    expect(formatSeekTime(NaN, NaN)).toBe('00:00')
    expect(formatSeekTime(-5, 600)).toBe('00:00')
    expect(formatSeekTime(30, Infinity)).toBe('00:30')
  })
})

describe('formatTimeDisplay', () => {
  test('carries the hours field on both halves for the long-form session', () => {
    expect(formatTimeDisplay(0, LONGFORM)).toBe('0:00:00 / 1:41:06')
    expect(formatTimeDisplay(12, LONGFORM)).toBe('0:00:12 / 1:41:06')
    expect(formatTimeDisplay(LONGFORM, LONGFORM)).toBe('1:41:06 / 1:41:06')
  })

  test('agrees with the hover bubble at the same position', () => {
    const at = 3661
    expect(formatTimeDisplay(at, LONGFORM).split(' / ')[0]).toBe(
      formatSeekTime(at, LONGFORM),
    )
  })

  test('stays on mm:ss for a short video', () => {
    expect(formatTimeDisplay(75, 600)).toBe('01:15 / 10:00')
  })

  test('agrees with the Duration stat, which formats the same seconds', () => {
    // The watch page derives the stat from `realFrames / FPS`, which is the
    // same number the engine displays as its total. Both are on screen with
    // the bubble, so all three have to render one string.
    const realFrames = Math.round(LONGFORM * 60)
    const statSecs = realFrames / 60
    const stat = formatSeekTime(statSecs, statSecs)
    expect(stat).toBe('1:41:06')
    expect(formatTimeDisplay(0, statSecs, LONGFORM).split(' / ')[1]).toBe(stat)
  })

  test('never renders half a pair in hours', () => {
    // A path shorter than the video: the video's length still decides the
    // format, so the total cannot drop the field the current position has.
    expect(formatTimeDisplay(30, 1800, LONGFORM)).toBe('0:00:30 / 0:30:00')
    // And the reverse — a scale under the hour keeps both halves short.
    expect(formatTimeDisplay(30, 1800, 1800)).toBe('00:30 / 30:00')
  })
})

describe('clampTooltipCenter', () => {
  test('leaves a bubble that already fits where it is', () => {
    expect(clampTooltipCenter(200, 48, 400)).toBe(200)
  })

  test('holds both edges inside the track', () => {
    expect(clampTooltipCenter(0, 48, 400)).toBe(24)
    expect(clampTooltipCenter(400, 48, 400)).toBe(376)
    expect(clampTooltipCenter(-50, 48, 400)).toBe(24)
  })

  test('centres a bubble wider than the track rather than picking an edge', () => {
    expect(clampTooltipCenter(10, 200, 100)).toBe(50)
  })
})
