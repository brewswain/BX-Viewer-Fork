/**
 * Video playback rate — the ladder of offered speeds and the maths around it.
 *
 * A rate control cannot be linear in the rate. 0.25→0.5 doubles the speed while
 * 3.5→4 changes it by 14%, so a linear 0.25–4 track spends most of its travel
 * in the range nobody asks for and turns 1× into a pixel hunt. The offered
 * rates are a fixed ladder instead and the slider indexes it, which makes every
 * detent a speed someone would actually pick and 1× a stop you cannot miss.
 *
 * Deliberately not the same idea as `defaultPathSpeed`, which scales how fast
 * the BounceX waveform scrolls past the playhead and never touches the video.
 *
 * Owned here rather than in the engine so the slider bounds, the settings page
 * and the keyboard steps cannot disagree about what the ladder is.
 */

/**
 * The rungs, ascending. Quarter steps through the range that gets used the most
 * and half steps above 2×, where the difference between neighbours is already
 * obvious and more rungs would only lengthen the drag.
 */
export const PLAYBACK_RATES = [
  0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4,
] as const

export const MIN_PLAYBACK_RATE = PLAYBACK_RATES[0]
export const MAX_PLAYBACK_RATE = PLAYBACK_RATES[PLAYBACK_RATES.length - 1]
/** Where everything falls back to, and what Reset means. */
export const NORMAL_PLAYBACK_RATE = 1

/**
 * Slider bounds. The control carries a *ladder index*, not a rate — a range
 * input with `step` cannot express uneven rungs, and one that could would be
 * back to the linear-track problem above.
 */
export const RATE_RANGE = {
  min: 0,
  max: PLAYBACK_RATES.length - 1,
  step: 1,
} as const

/**
 * Anything at all coerced onto the ladder. Snapping rather than merely clamping
 * is what lets the slider, the readout and `video.playbackRate` be read off one
 * value: a stored 1.9 from a hand-edited settings blob becomes 2, not a rate
 * the slider has no position for.
 */
export function clampRate(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return NORMAL_PLAYBACK_RATE
  return PLAYBACK_RATES[rateIndex(n)]
}

/** Index of the nearest rung. Ties go to the slower of the two. */
export function rateIndex(rate: number): number {
  if (!Number.isFinite(rate)) return PLAYBACK_RATES.indexOf(NORMAL_PLAYBACK_RATE)
  let best = 0
  let bestErr = Infinity
  for (let i = 0; i < PLAYBACK_RATES.length; i++) {
    const err = Math.abs(PLAYBACK_RATES[i] - rate)
    if (err < bestErr) {
      bestErr = err
      best = i
    }
  }
  return best
}

/** Rate at a slider position, with out-of-range indices pinned to the ends. */
export function rateAt(index: number): number {
  if (!Number.isFinite(index)) return NORMAL_PLAYBACK_RATE
  const i = Math.round(index)
  if (i <= 0) return MIN_PLAYBACK_RATE
  if (i >= PLAYBACK_RATES.length - 1) return MAX_PLAYBACK_RATE
  return PLAYBACK_RATES[i]
}

/**
 * One rung up or down from wherever `rate` currently sits, stopping at the
 * ends. A rate that is between rungs snaps to its nearest one first, so the
 * keys can never walk off the ladder.
 */
export function stepRate(rate: number, direction: 1 | -1): number {
  return rateAt(rateIndex(clampRate(rate)) + direction)
}

/**
 * `1×`, `1.25×`, `0.25×`. Trailing zeros dropped, because a readout this small
 * sits next to a slider and "1.00×" reads as more precision than there is.
 */
export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`
}
