'use client'

import { memo, type RefObject } from 'react'

/**
 * The `<video>`, the optional loading/buffering/seeking overlays, and the
 * BounceX canvas.
 *
 * Every id and class name is unchanged: app/globals.css targets them, and the
 * engine still looks the overlay nodes up by id.
 */

type Props = {
  /** Inline video src (null for playlist, which sets `video.src` imperatively). */
  videoSrc?: string | null
  /** Include the loading/buffering/seeking overlays (single-video only). */
  hasLoadingOverlays?: boolean
  videoRef?: RefObject<HTMLVideoElement | null>
  canvasRef?: RefObject<HTMLCanvasElement | null>
  bxWrapRef?: RefObject<HTMLDivElement | null>
}

function VideoWrap({
  videoSrc = null,
  hasLoadingOverlays = false,
  videoRef,
  canvasRef,
  bxWrapRef,
}: Props) {
  const preload = hasLoadingOverlays ? 'auto' : 'metadata'

  return (
    <div className="player-video-wrap" id="videoWrap">
      <video id="mainVideo" preload={preload} ref={videoRef}>
        {videoSrc ? <source src={videoSrc} type="video/mp4" /> : null}
      </video>
      {/* Play/pause glyph the engine flashes on each toggle; icon is filled in
          imperatively, so the initial markup is empty. */}
      <div
        className="video-tap-indicator"
        id="videoTapIndicator"
        aria-hidden="true"
      >
        <svg
          id="videoTapIndicatorIcon"
          viewBox="0 0 24 24"
          fill="currentColor"
        ></svg>
      </div>
      {hasLoadingOverlays && (
        <>
          <div
            className="video-overlay video-loading-overlay"
            id="videoLoadingOverlay"
          >
            <span className="video-overlay-spinner"></span>
            <span className="video-overlay-text" id="videoLoadingProgressText">
              Loading video…
            </span>
            <div className="video-loading-progress" id="videoLoadingProgress">
              <div className="video-loading-progress-bar">
                <div
                  className="video-loading-progress-fill"
                  id="videoLoadingProgressFill"
                ></div>
              </div>
            </div>
            <span className="video-overlay-hint">
              Large files may take a while. If it stays on &quot;Loading
              metadata…&quot;, the file may need remuxing with faststart.
            </span>
          </div>
          <div
            className="video-overlay video-buffering-overlay"
            id="videoBufferingOverlay"
            aria-hidden="true"
          >
            <span className="video-overlay-spinner"></span>
            <span className="video-overlay-text">Buffering…</span>
          </div>
          <div
            className="video-overlay video-seeking-overlay"
            id="videoSeekingOverlay"
            aria-hidden="true"
          >
            <span className="video-overlay-spinner"></span>
            <span className="video-overlay-text" id="videoSeekingOverlayText">
              Seeking…
            </span>
            <span
              className="video-overlay-hint video-seeking-hint"
              id="videoSeekingOverlayHint"
              aria-hidden="true"
            >
              Previously watched parts may need to load again.
            </span>
          </div>
        </>
      )}
      <div className="bouncex-wrap" id="bxWrap" ref={bxWrapRef}>
        <canvas className="bouncex-canvas" id="bxCanvas" ref={canvasRef}></canvas>
      </div>
    </div>
  )
}

export default memo(VideoWrap)
