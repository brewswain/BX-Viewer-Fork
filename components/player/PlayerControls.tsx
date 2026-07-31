'use client'

import { memo, type ReactNode } from 'react'

/**
 * JSX port of `buildControlsHTML()` from app/player-core.js — progress bar plus
 * the two control rows. Ids and class names are unchanged; the engine binds to
 * them by id.
 *
 * `playIcon` / `volIcon` render their contents through
 * `dangerouslySetInnerHTML` on purpose: the engine swaps those SVG children by
 * assigning `innerHTML`, and raw-HTML children keep React out of that subtree
 * instead of leaving it holding stale child fibers.
 */

const PLAY_ICON_HTML = '<polygon points="5,3 19,12 5,21"/>'
const VOL_ICON_HTML =
  '<polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M15.54,8.46a5,5,0,0,1,0,7.07"/><path d="M19.07,4.93a10,10,0,0,1,0,14.14"/>'

type Props = {
  /** Include prev/next track buttons (playlist). */
  hasPrevNext?: boolean
  /** Include the flip-Y button. */
  hasFlipY?: boolean
  /** Contents of `#bxSelectWrap` — the bx-file `<select>`, when there is one. */
  bxSelect?: ReactNode
  /** Total tracks for trackDisplay (playlist). */
  totalCount?: number | null
  /** Initial duration string for timeDisplay. */
  duration?: string
  /** Track counter text; defaults to `1 / totalCount` like the legacy markup. */
  trackDisplay?: string
  onPrevTrack?: () => void
  onNextTrack?: () => void
}

function PlayerControls({
  hasPrevNext = false,
  hasFlipY = false,
  bxSelect = null,
  totalCount = null,
  duration = '00:00',
  trackDisplay,
  onPrevTrack,
  onNextTrack,
}: Props) {
  const showTrackDisplay = hasPrevNext && totalCount !== null

  return (
    <div className="player-controls">
      <div className="progress-bar-wrap" id="progressWrap">
        <div className="progress-bar-fill" id="progressFill"></div>
        <div className="progress-bar-thumb" id="progressThumb"></div>
      </div>

      {/* Primary row: transport + time + fullscreen */}
      <div className="controls-row">
        {hasPrevNext && (
          <button
            className="ctrl-btn"
            id="btnPrevTrack"
            title="Previous video"
            onClick={onPrevTrack}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="19,20 9,12 19,4" />
              <line x1="5" y1="4" x2="5" y2="20" />
            </svg>
          </button>
        )}
        <button className="ctrl-btn" id="btnRewind" title="Rewind 5s">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="11,17 6,12 11,7" />
            <polyline points="18,17 13,12 18,7" />
          </svg>
        </button>
        <button className="ctrl-btn play-btn" id="btnPlay" title="Play / Pause">
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            id="playIcon"
            dangerouslySetInnerHTML={{ __html: PLAY_ICON_HTML }}
          />
        </button>
        <button className="ctrl-btn" id="btnForward" title="Forward 5s">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="13,17 18,12 13,7" />
            <polyline points="6,17 11,12 6,7" />
          </svg>
        </button>
        {hasPrevNext && (
          <button
            className="ctrl-btn"
            id="btnNextTrack"
            title="Next video"
            onClick={onNextTrack}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="5,4 15,12 5,20" />
              <line x1="19" y1="4" x2="19" y2="20" />
            </svg>
          </button>
        )}

        <span className="time-display" id="timeDisplay">
          {`00:00 / ${duration}`}
        </span>
        {showTrackDisplay && (
          <span
            className="time-display"
            style={{ color: 'var(--text3)' }}
            id="trackDisplay"
          >
            {trackDisplay ?? `1 / ${totalCount}`}
          </span>
        )}

        <div className="controls-spacer"></div>

        <button className="ctrl-btn" id="btnTheater" title="Theater mode">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            id="theaterIcon"
          >
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <rect
              x="5"
              y="7"
              width="14"
              height="10"
              rx="1"
              fill="currentColor"
              stroke="none"
              opacity="0.35"
            />
          </svg>
        </button>
        <button className="ctrl-btn" id="btnFullscreen" title="Fullscreen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15,3 21,3 21,9" />
            <polyline points="9,21 3,21 3,15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
      </div>

      {/* Secondary row: overlay toggles, zoom, volume */}
      <div className="controls-row controls-row-secondary">
        <button
          className="overlay-toggle-btn"
          id="overlayBtn"
          title="Toggle BounceX overlay"
        >
          overlay: off
        </button>
        <button
          className="overlay-toggle-btn"
          id="overlayBgBtn"
          title="Toggle overlay background"
          style={{ display: 'none' }}
        >
          bg: off
        </button>
        {hasFlipY && (
          <button
            className="overlay-toggle-btn"
            id="flipYBtn"
            title="Flip waveform Y axis (depth 1 = bottom)"
          >
            flip Y: off
          </button>
        )}
        <span id="bxSelectWrap">{bxSelect}</span>

        <div className="controls-spacer"></div>

        <div className="volume-wrap zoom-wrap">
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: '0.68rem',
              color: 'var(--text3)',
              letterSpacing: '0.04em',
              whiteSpace: 'nowrap',
            }}
          >
            zoom
          </span>
          <input
            type="range"
            className="zoom-slider"
            id="zoomSlider"
            min="0.05"
            max="0.50"
            step="0.05"
            defaultValue="0.25"
          />
        </div>

        <div className="volume-wrap zoom-wrap">
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: '0.68rem',
              color: 'var(--text3)',
              letterSpacing: '0.04em',
              whiteSpace: 'nowrap',
            }}
          >
            speed
          </span>
          <input
            type="range"
            className="zoom-slider"
            id="speedSlider"
            min="0.5"
            max="4.0"
            step="0.25"
            defaultValue="1.0"
          />
        </div>

        <div className="volume-wrap">
          <button className="ctrl-btn" id="btnMute" title="Mute">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              id="volIcon"
              dangerouslySetInnerHTML={{ __html: VOL_ICON_HTML }}
            />
          </button>
          <input
            type="range"
            className="volume-slider"
            id="volumeSlider"
            min="0"
            max="1"
            step="0.01"
            defaultValue="1"
          />
        </div>
      </div>
    </div>
  )
}

export default memo(PlayerControls)
