/**
 * How the picture is fitted to the theater stage.
 *
 * Theater keeps the .bx strip in the layout, so the box left for the video is
 * always wider than the screen's own aspect ratio — a 16:9 video on a 16:9
 * monitor ends up in a ~2.4:1 box, and `object-fit: contain` answers that with
 * pillarbox bars taking a third of the width.
 *
 * So the picture is pushed out past `contain` with two bounded moves, in the
 * order that costs the least:
 *
 *   1. stretch it horizontally (anamorphic — geometry warps, nothing is lost)
 *   2. zoom both axes (nothing warps, but the top and bottom are cropped)
 *
 * Both are capped, and whatever the caps cannot close stays as bars — a hard
 * limit on how wrong the picture is allowed to get. Neither move touches the
 * layout: they come out as a `transform` on the video, so the box, the strip
 * and the canvas are all unaffected.
 */

/** Widest anamorphic stretch allowed, as a multiple of the true width. */
export const MAX_STRETCH = 1.3
/**
 * Deepest zoom allowed — currently off entirely. Zoom is the move that costs
 * picture, and what it costs first is the bottom edge, which is where a video
 * with the path burned into the frame keeps its path. Crop far enough and that
 * burned-in path is clipped by the strip below it, and the two read as one
 * overlapping mess. At 1.0 the stretch does all the work and nothing is lost.
 */
export const MAX_ZOOM = 1.0

/**
 * How far the live controls (and any stored override) may push each cap.
 *
 * The floor is 1 for both — below it the "fit" would shrink the picture, which
 * is not a thing theater has any use for. The ceilings are where the tradeoff
 * stops being worth offering: past ~1.6 the anamorphic warp reads as a funhouse
 * mirror, and past ~1.4 zoom eats the burned-in path at the bottom edge no
 * matter what the footage is.
 */
export const STRETCH_RANGE = { min: 1, max: 1.6, step: 0.02 } as const
export const ZOOM_RANGE = { min: 1, max: 1.4, step: 0.02 } as const

/** A cap coerced into range, falling back to the shipped default. */
export function clampStretch(n: unknown): number {
  return clampTo(n, STRETCH_RANGE, MAX_STRETCH)
}

export function clampZoom(n: unknown): number {
  return clampTo(n, ZOOM_RANGE, MAX_ZOOM)
}

function clampTo(
  n: unknown,
  range: { min: number; max: number },
  fallback: number,
): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(range.max, Math.max(range.min, n))
}

export type TheaterFit = {
  /** Horizontal scale to apply to the video element. */
  scaleX: number
  /** Vertical scale — the zoom alone; the stretch is horizontal only. */
  scaleY: number
}

const IDENTITY: TheaterFit = { scaleX: 1, scaleY: 1 }

export type FitLimits = { maxStretch?: number; maxZoom?: number }

/**
 * Scale factors that close the pillarbox gap between a `contain`-fitted video
 * and the box it sits in, as far as the caps allow.
 *
 * Returns identity for anything unmeasurable (metadata not in yet, a collapsed
 * box) and for a video that is already wider than its box — that one is
 * letterboxed top and bottom, which theater has no reason to fight.
 */
export function theaterFit(
  boxW: number,
  boxH: number,
  vidW: number,
  vidH: number,
  { maxStretch = MAX_STRETCH, maxZoom = MAX_ZOOM }: FitLimits = {},
): TheaterFit {
  if (![boxW, boxH, vidW, vidH].every((n) => Number.isFinite(n) && n > 0))
    return IDENTITY

  // A portrait video is a shape, not a mistake: it will never come close to
  // filling a landscape stage, so warping it 20% buys a sliver of width and
  // costs the whole picture. Left alone deliberately.
  if (vidW < vidH) return IDENTITY

  // How much wider the box is than the picture `contain` drew into it. At or
  // below 1 the picture already spans the full width.
  const gap = boxW / boxH / (vidW / vidH)
  if (gap <= 1) return IDENTITY

  const stretch = Math.min(gap, Math.max(1, maxStretch))
  const zoom = Math.min(gap / stretch, Math.max(1, maxZoom))
  return { scaleX: stretch * zoom, scaleY: zoom }
}

/** The `transform` value for a fit, or `''` when it changes nothing. */
export function fitTransform(fit: TheaterFit): string {
  if (fit.scaleX === 1 && fit.scaleY === 1) return ''
  return `scale(${fit.scaleX.toFixed(4)}, ${fit.scaleY.toFixed(4)})`
}
