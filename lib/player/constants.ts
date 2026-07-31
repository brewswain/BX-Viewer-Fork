/**
 * Shared player constants — ported verbatim from app/player-core.js.
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
