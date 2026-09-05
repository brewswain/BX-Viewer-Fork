/**
 * Which slice of the marker list is worth putting in the DOM.
 *
 * A longform path is not a few hundred rows. `longform7-full.bx` carries 21,053
 * markers and `longform8-full.bx` 18,343, and each row is six elements plus a
 * fiber and a click closure, so rendering the list whole is roughly 126,000
 * nodes built synchronously and reconciled again on every render of the page.
 * The panel is 340px tall and shows nine of them.
 *
 * `content-visibility: auto` on the rows already spares the paint and layout
 * for the ones off screen, which is what made the list bearable at 4k markers,
 * but it does nothing about building or reconciling them. This is the other
 * half.
 *
 * Kept pure and separate from the engine so it can be tested; the component
 * owns the scroll listener and the measurement.
 */

/** Rows kept in the DOM beyond each edge of the scrollport. */
export const MARKER_OVERSCAN = 8

/**
 * Row pitch (height plus the margin below it) before anything has been
 * measured. Matches `.marker-list-item` at the default root font size, and is
 * only ever used for the first paint: the component measures two live rows and
 * uses that from then on, so a zoomed page or a changed font size corrects
 * itself rather than drifting.
 */
export const MARKER_ROW_PITCH = 36.6

export type MarkerWindow = {
  /** First index to render, inclusive. */
  start: number
  /** Last index to render, exclusive. */
  end: number
}

/**
 * `scrollTop` and `viewportH` come off the scroll container. A pitch that is
 * not a usable number means the rows have never been measured and the fallback
 * was somehow lost, so the whole list is returned: degrading to the old
 * behaviour is right, rendering an empty panel is not.
 */
export function markerWindow(
  scrollTop: number,
  viewportH: number,
  total: number,
  pitch: number,
  overscan: number = MARKER_OVERSCAN,
): MarkerWindow {
  if (total <= 0) return { start: 0, end: 0 }
  if (!Number.isFinite(pitch) || pitch <= 0) return { start: 0, end: total }

  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0
  const height = Number.isFinite(viewportH) ? Math.max(0, viewportH) : 0

  const first = Math.floor(top / pitch)
  // The partial row at each edge counts, hence the +1 before the overscan.
  const visible = Math.ceil(height / pitch) + 1

  const start = Math.max(0, Math.min(first - overscan, total))
  const end = Math.max(start, Math.min(first + visible + overscan, total))
  return { start, end }
}
