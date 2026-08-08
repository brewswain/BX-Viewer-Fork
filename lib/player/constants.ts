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

// Theater tuning
/** Floor for the theater strip, as a fraction of the viewport height. */
export const BX_THEATER_MIN_VH = 0.25
/** Ceiling for the theater strip, as a fraction of the viewport height. */
export const BX_THEATER_MAX_VH = 0.35
/** How close to the bottom edge the pointer must get to raise the controls. */
export const THEATER_EDGE_ZONE = 32
