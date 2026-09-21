/**
 * Shared player constants.
 *
 * `VIDEO_BASE` / `PLAYLIST_BASE` are *client-side URL* prefixes (relative, no
 * leading slash) and are deliberately unrelated to the filesystem paths in
 * `@/lib/paths`.
 */

export const VIDEO_BASE = 'videos'
export const PLAYLIST_BASE = 'playlists'

export const FPS = 60

// Canvas / rendering constants — single source of truth
export const BALL_R = 7
export const PX_PER_FRAME = 3
export const EDGE_PAD = 8
export const BX_HEIGHT_BELOW = 100 // px height when not in overlay mode (reference)
export const BX_HEIGHT_OVERLAY = 200 // px height when in overlay mode
/**
 * Alpha of the scrim drawn behind the path in overlay mode. Enough to read the
 * path against a bright frame, little enough to keep the picture legible —
 * which is a per-video judgement, so it is the starting point rather than the
 * value: the secondary control row adjusts it live.
 */
export const DEFAULT_OVERLAY_BG_OPACITY = 0.45

/**
 * The stops offered by the control bar's `zoom` and `path speed` dropdowns.
 *
 * Both were range inputs over an evenly spaced set of values, which a 70px
 * track renders as a pixel hunt: a <select> names every stop instead. The
 * bounds match what the settings page writes, so a saved default always has an
 * option to land on — and `snapStep` covers the blob that was hand-edited or
 * written by an older build that allowed a wider range.
 */
export const BX_ZOOM_STEPS = [
  0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5,
] as const

export const PATH_SPEED_STEPS = [
  0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4,
] as const

/** Nearest offered stop, for a value the dropdown has no option for. */
export function snapStep(
  steps: readonly number[],
  value: unknown,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return steps.reduce((best, s) =>
    Math.abs(s - value) < Math.abs(best - value) ? s : best,
  )
}

// Theater tuning
/** Floor for the theater strip, as a fraction of the viewport height. */
export const BX_THEATER_MIN_VH = 0.25
/** Ceiling for the theater strip, as a fraction of the viewport height. */
export const BX_THEATER_MAX_VH = 0.35
/** How close to the bottom edge the pointer must get to raise the controls. */
export const THEATER_EDGE_ZONE = 32
