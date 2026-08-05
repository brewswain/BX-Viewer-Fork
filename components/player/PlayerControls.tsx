'use client'

import { memo, type ReactNode } from 'react'

import type { LoopMode, PlaylistLoopMode } from '@/lib/player/playback'

/**
 * Progress bar plus the two control rows. The engine binds to these elements
 * by id, so ids and class names here are part of its contract.
 *
 * `playIcon` / `volIcon` render their contents through
 * `dangerouslySetInnerHTML` on purpose: the engine swaps those SVG children by
 * assigning `innerHTML`, and raw-HTML children keep React out of that subtree
 * instead of leaving it holding stale child fibers.
 */

const PLAY_ICON_HTML = '<polygon points="5,3 19,12 5,21"/>'
const VOL_ICON_HTML =
  '<polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M15.54,8.46a5,5,0,0,1,0,7.07"/><path d="M19.07,4.93a10,10,0,0,1,0,14.14"/>'

/**
 * Per-mode label and badge for the loop button. Playlist modes (`all`/`one`)
 * and single-video modes (`once`/`forever`) share the control, so they share
 * one table; `off` is common to both.
 */
const LOOP_UI: Record<string, { title: string; badge: string | null }> = {
  off: { title: 'Loop: off', badge: null },
  all: { title: 'Loop: whole playlist', badge: '∞' },
  one: { title: 'Loop: current video only', badge: '1' },
  once: { title: 'Loop: one extra play', badge: '+1' },
  forever: { title: 'Loop: forever', badge: '∞' },
}

type Props = {
  /** Include prev/next track buttons (playlist). */
  hasPrevNext?: boolean
  /** Include the flip-Y button. */
  hasFlipY?: boolean
  /** Current loop mode; omit to leave the loop button out entirely. */
  loopMode?: LoopMode | PlaylistLoopMode | null
  /** Advance the loop mode one step. */
  onCycleLoop?: () => void
  /** Current shuffle state; omit to leave the shuffle button out (single video). */
  shuffle?: boolean | null
  onToggleShuffle?: () => void
  /**
   * Render the theater playlist-drawer toggle. It carries no handler: the
   * engine binds `#btnPlaylistDrawer` by id, the same way it owns theater and
   * fullscreen, so the drawer closes with theater without a second owner.
   */
  hasPlaylistDrawer?: boolean
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
  loopMode = null,
  onCycleLoop,
  shuffle = null,
  onToggleShuffle,
  hasPlaylistDrawer = false,
  bxSelect = null,
  totalCount = null,
  duration = '00:00',
  trackDisplay,
  onPrevTrack,
  onNextTrack,
}: Props) {
  const showTrackDisplay = hasPrevNext && totalCount !== null
  const loopUi = loopMode ? (LOOP_UI[loopMode] ?? LOOP_UI.off) : null

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

        {loopUi && (
          <button
            className={
              loopMode === 'off' ? 'ctrl-btn loop-btn' : 'ctrl-btn loop-btn active'
            }
            id="btnLoop"
            title={loopUi.title}
            aria-label={loopUi.title}
            onClick={onCycleLoop}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="17,2 21,6 17,10" />
              <path d="M3 12V10a4 4 0 0 1 4-4h14" />
              <polyline points="7,22 3,18 7,14" />
              <path d="M21 12v2a4 4 0 0 1-4 4H3" />
            </svg>
            {loopUi.badge && <span className="ctrl-btn-badge">{loopUi.badge}</span>}
          </button>
        )}
        {shuffle !== null && (
          <button
            className={shuffle ? 'ctrl-btn active' : 'ctrl-btn'}
            id="btnShuffle"
            title={`Shuffle: ${shuffle ? 'on' : 'off'}`}
            aria-label={`Shuffle: ${shuffle ? 'on' : 'off'}`}
            onClick={onToggleShuffle}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="16,3 21,3 21,8" />
              <line x1="4" y1="20" x2="21" y2="3" />
              <polyline points="21,16 21,21 16,21" />
              <line x1="15" y1="15" x2="21" y2="21" />
              <line x1="4" y1="4" x2="9" y2="9" />
            </svg>
          </button>
        )}
        {hasPlaylistDrawer && (
          <button
            className="ctrl-btn theater-only"
            id="btnPlaylistDrawer"
            title="Playlist (P)"
            aria-label="Toggle playlist"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="6" x2="14" y2="6" />
              <line x1="3" y1="12" x2="14" y2="12" />
              <line x1="3" y1="18" x2="10" y2="18" />
              <polygon points="17,10 22,13 17,16" fill="currentColor" stroke="none" />
            </svg>
          </button>
        )}

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
