/**
 * Frame previews for the seek bar — the thumbnail half of the hover bubble
 * whose clock lives in `seekTooltip.ts`.
 *
 * Only the decisions worth pinning down are here, all pure: whether a file is
 * worth a preview element at all, when a hover position is worth a seek, and
 * the box a frame is drawn into. The decoding itself stays in the engine, which
 * owns the off-DOM `<video>` the frames come out of.
 */

/**
 * Above this long, a hover thumbnail is not worth a second reader of the file.
 * See `previewWorthBuilding`.
 */
export const PREVIEW_MAX_DURATION_SECS = 20 * 60

/**
 * Whether this video can afford a second element decoding frames out of it.
 *
 * Firefox keeps ONE media cache for the whole content process (500 MiB by
 * default, 8 GB on a machine tuned per `PLAYBACK-TUNING.md`), and the high
 * readahead limit that tuning prescribes is an instruction to every element to
 * pull its whole file into it. At the library's ~10 Mbps a 90-minute carrier is
 * about 6.7 GB, so two elements on one of those ask for more than the cache
 * holds. It fills, no block is evictable because a reader still needs it, and
 * then BOTH elements wedge for good, the playing one included. Measured on
 * `longform-machine-session-eight` 2026-09-05: the page's video fell from
 * readyState 4 to 0 the moment a second element opened the same src, and only a
 * full page load cleared it; a client-side nav does not.
 *
 * Twenty minutes is ~1.5 GB, so a pair of those still fits with room over, and
 * nothing in the library sits near the line: the clips run to minutes and the
 * longform carriers to 80-103. A duration that is not a number yet cannot be
 * ruled a clip, and the cost of guessing wrong is the whole tab, so it is
 * refused until the element reports one. The bubble keeps its timecode either
 * way; it is only the picture in it that a long carrier gives up.
 */
export function previewWorthBuilding(durationSecs: number): boolean {
  if (!Number.isFinite(durationSecs) || durationSecs <= 0) return false
  return durationSecs <= PREVIEW_MAX_DURATION_SECS
}

/**
 * One preview seek at a time.
 *
 * A pointer sweeping the bar asks for a new frame every few milliseconds, but a
 * video element services one seek at a time and coalesces targets set mid-seek
 * on its own — badly, from here: the `seeked` you get back is for a position
 * you can no longer identify. So requests are coalesced here instead. The
 * in-flight seek runs to completion, and only the *latest* position waiting
 * behind it is served next; the positions swept past in between are dropped on
 * purpose, because nobody was looking at them.
 */
export type PreviewSeekState = {
  /** Position the video element is currently seeking to, if any. */
  inFlight: number | null
  /** Latest position asked for while a seek was in flight. */
  pending: number | null
  /** Position of the frame already on screen, so a re-ask draws nothing new. */
  drawn: number | null
}

export type PreviewSeekStep = {
  state: PreviewSeekState
  /** Position to seek the preview element to now, or null to stay put. */
  seekTo: number | null
}

export const idlePreviewSeek = (): PreviewSeekState => ({
  inFlight: null,
  pending: null,
  drawn: null,
})

/** Whether `target` is far enough from the drawn frame to be a different one. */
function worthSeeking(state: PreviewSeekState, target: number, minDelta: number) {
  return state.drawn === null || Math.abs(target - state.drawn) >= minDelta
}

/**
 * Ask for the frame at `target`. `minDelta` is the smallest gap that can put a
 * different frame on screen — the engine derives it from the track's own width,
 * so a pointer that has not crossed a pixel cannot cost a seek.
 */
export function requestPreviewSeek(
  state: PreviewSeekState,
  target: number,
  minDelta: number,
): PreviewSeekStep {
  if (state.inFlight !== null) {
    return { state: { ...state, pending: target }, seekTo: null }
  }
  if (!worthSeeking(state, target, minDelta)) return { state, seekTo: null }
  return { state: { ...state, inFlight: target, pending: null }, seekTo: target }
}

/**
 * The in-flight seek finished. `drew` is false for one the engine gave up on
 * (a stall, or a track swapped out from under it): the position is released so
 * the next hover can re-ask for it, but `drawn` keeps pointing at the frame
 * that is actually on screen rather than at one that never arrived.
 */
export function completePreviewSeek(
  state: PreviewSeekState,
  minDelta: number,
  drew = true,
): PreviewSeekStep {
  const settled: PreviewSeekState = {
    inFlight: null,
    pending: null,
    drawn: drew && state.inFlight !== null ? state.inFlight : state.drawn,
  }
  if (state.pending === null) return { state: settled, seekTo: null }
  return requestPreviewSeek(settled, state.pending, minDelta)
}

/** 16:9, for a video that has not reported its own dimensions yet. */
const FALLBACK_ASPECT = 16 / 9

/**
 * The thumbnail box. Width leads — a preview is a strip along a seek bar, and
 * every landscape video should give the same one — until the frame is tall
 * enough that `maxW` would push it past `maxH`, which is what keeps a portrait
 * clip from growing a bubble taller than the player.
 */
export function previewThumbBox(
  videoW: number,
  videoH: number,
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  const usable =
    Number.isFinite(videoW) && Number.isFinite(videoH) && videoW > 0 && videoH > 0
  const aspect = usable ? videoW / videoH : FALLBACK_ASPECT
  const width = Math.min(maxW, maxH * aspect)
  return { width: Math.round(width), height: Math.round(width / aspect) }
}
