/**
 * Clock formatting and geometry for the seek bar — the hover bubble and the
 * `current / total` readout beside it, which have to agree on screen.
 *
 * Kept out of the engine because it is all pure and it all has edge cases worth
 * pinning down: a 101-minute session needs an hours field, and the bubble has
 * to stay inside a track that is only a few hundred pixels wide.
 */

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * `secs` as a clock. The hours field is decided by `durationSecs`, not by the
 * position being formatted: a 101-minute video reads `0:00:12` at the head
 * rather than flipping from `00:12` to `1:00:12` on the way past the hour.
 */
export function formatSeekTime(secs: number, durationSecs?: number): string {
  const t = Number.isFinite(secs) && secs > 0 ? Math.floor(secs) : 0
  const scale =
    typeof durationSecs === 'number' && Number.isFinite(durationSecs)
      ? Math.max(t, Math.floor(durationSecs))
      : t
  const s = t % 60
  if (scale < 3600) return `${pad2(Math.floor(t / 60))}:${pad2(s)}`
  return `${Math.floor(t / 3600)}:${pad2(Math.floor(t / 60) % 60)}:${pad2(s)}`
}

/**
 * The `current / total` pair on the control bar. Both halves are formatted
 * against one scale so the pair can never be half in hours, and `scaleSecs`
 * defaults away from `totalSecs` only where the engine has a truer duration
 * than the path length it displays — that is what keeps this agreeing with the
 * hover bubble, which measures the video rather than the .bx.
 */
export function formatTimeDisplay(
  currentSecs: number,
  totalSecs: number,
  scaleSecs: number = totalSecs,
): string {
  return `${formatSeekTime(currentSecs, scaleSecs)} / ${formatSeekTime(totalSecs, scaleSecs)}`
}

/**
 * Where to put the bubble's centre, in px from the track's left edge, given
 * that it is drawn with `translateX(-50%)`. Clamped so neither edge overflows
 * the track — and centred outright when the bubble is wider than the track,
 * which is the only case where both clamps cannot hold at once.
 */
export function clampTooltipCenter(
  centerPx: number,
  tipWidth: number,
  trackWidth: number,
): number {
  const half = tipWidth / 2
  if (tipWidth >= trackWidth) return trackWidth / 2
  return Math.min(Math.max(centerPx, half), trackWidth - half)
}
