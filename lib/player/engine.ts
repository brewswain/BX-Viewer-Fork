/**
 * BounceX player engine.
 *
 * Deliberately imperative and *outside* React: the render loop is driven by
 * requestAnimationFrame and mutates the canvas and the control DOM directly.
 * Pages create it once from a `useEffect` and drive it through the returned
 * handle. Control elements are still looked up by `id` — the React components
 * under `components/player/` render the exact same ids and class names, and
 * never re-render the nodes the engine mutates.
 *
 * The only addition over the legacy handle is `destroy()`, which the pages call
 * on unmount so the rAF loop and the document-level listeners don't outlive the
 * route (the legacy page was torn down by a full navigation instead).
 */

import type { Settings } from '@/lib/settings'
import {
  BALL_R,
  BX_HEIGHT_OVERLAY,
  BX_THEATER_MAX_VH,
  BX_THEATER_MIN_VH,
  DEFAULT_OVERLAY_BG_OPACITY,
  EDGE_PAD,
  FPS,
  PX_PER_FRAME,
  THEATER_EDGE_ZONE,
} from './constants'
import {
  buildColors,
  getEffectFadeAlpha,
  getEffectiveColorRgb,
  hexToRgbArr,
} from './format'
import {
  NORMAL_PLAYBACK_RATE,
  clampRate,
  formatRate,
  rateAt,
  rateIndex,
  stepRate,
} from './playbackRate'
import {
  completePreviewSeek,
  idlePreviewSeek,
  previewThumbBox,
  previewWorthBuilding,
  requestPreviewSeek,
  type PreviewSeekState,
} from './seekPreview'
import {
  clampTooltipCenter,
  formatSeekTime,
  formatTimeDisplay,
} from './seekTooltip'
import {
  clampStretch,
  clampZoom,
  theaterFit,
  type TheaterFit,
} from './theaterFit'
import type { BxEffect } from './types'

export type PlayerEngineOptions = {
  video: HTMLVideoElement
  canvas: HTMLCanvasElement
  /** The `.bouncex-wrap` div. */
  bxWrap: HTMLElement
  userSettings: Partial<Settings>
  /** Seconds before the path starts (default 0). */
  offsetSecs?: number
  /**
   * Honour the persisted `defaultTheater` setting on startup. Opt-in per page
   * rather than automatic, so a host that has no business starting immersive
   * (a preview, an embed) does not have to fight the setting.
   */
  autoTheater?: boolean
  /** Video ended (playlist: advance track). */
  onEnded?: () => void
  /** Every rAF with the current integer frame + depth. */
  onFrame?: (frame: number, depth: number) => void
  onSeeking?: () => void
  onSeeked?: () => void
  onCanPlay?: () => void
  onWaiting?: () => void
  onPlaying?: () => void
  onProgress?: () => void
}

export type PlayerEngine = {
  /** Swap in new bx path data (used by playlist on each track change). */
  loadBxData(
    path: Float32Array | null,
    frames: number,
    effects?: BxEffect[],
    peaks?: number[],
  ): void
  /** Reset smooth-time interpolation (used by playlist on each track change). */
  resetSmoothTime(): void
  /** Imperatively resize the canvas (used by playlist after loadTrack). */
  resizeCanvas(): void
  /** Update the path start offset in seconds (0 = no offset). */
  setOffset(secs: number): void
  /** Stop the rAF loop and detach every listener. Not in the legacy API. */
  destroy(): void
}

/** Vendor-prefixed fullscreen surface, still needed for older WebKit. */
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void>
}
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void>
}

/** Shared by the control-bar button and the click-to-toggle flash indicator. */
const PLAY_GLYPH = `<polygon points="5,3 19,12 5,21"/>`
const PAUSE_GLYPH = `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`

/** Elements the engine owns are required — a missing id is a programming error. */
function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

/**
 * Whether a keystroke belongs to something the user is typing or dragging in,
 * in which case the player's shortcuts must stay out of its way — Space in a
 * comment box types a space, it does not toggle playback.
 *
 * `contentEditable` is checked alongside the tags because a rich-text field is
 * an ordinary <div> as far as `tagName` is concerned.
 */
/** An alpha coerced into 0–1, falling back to the shipped scrim. */
function clampOpacity(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n))
    return DEFAULT_OVERLAY_BG_OPACITY
  return Math.min(1, Math.max(0, n))
}

function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  )
}

export function createPlayerEngine(opts: PlayerEngineOptions): PlayerEngine {
  const {
    video,
    canvas,
    bxWrap,
    userSettings,
    onEnded,
    onFrame,
    onSeeking,
    onSeeked,
    onCanPlay,
    onWaiting,
    onPlaying,
    onProgress,
  } = opts

  let offsetSecs = typeof opts.offsetSecs === 'number' ? opts.offsetSecs : 0

  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D

  // DOM refs — all must exist in the page by the time this runs
  const overlayBtn = byId<HTMLButtonElement>('overlayBtn')
  const overlayBgBtn = byId<HTMLButtonElement>('overlayBgBtn')
  const overlayBgOpacityWrap = byId<HTMLElement>('overlayBgOpacityWrap')
  const overlayBgOpacitySlider = byId<HTMLInputElement>('overlayBgOpacitySlider')
  const overlayBgOpacityValue = byId<HTMLElement>('overlayBgOpacityValue')
  const progressFill = byId<HTMLElement>('progressFill')
  const progressThumb = byId<HTMLElement>('progressThumb')
  const timeDisplay = byId<HTMLElement>('timeDisplay')
  const btnPlay = byId<HTMLButtonElement>('btnPlay')
  const playIcon = byId<HTMLElement>('playIcon')
  const btnRewind = byId<HTMLButtonElement>('btnRewind')
  const btnForward = byId<HTMLButtonElement>('btnForward')
  // Track stepping belongs to the page, not the engine — these are React
  // buttons with their own onClick, and both are null on a single video. The
  // keyboard drives them by clicking rather than by reimplementing what
  // advancing a track means.
  const btnPrevTrack = byId<HTMLButtonElement>('btnPrevTrack')
  const btnNextTrack = byId<HTMLButtonElement>('btnNextTrack')
  const btnMute = byId<HTMLButtonElement>('btnMute')
  const volIcon = byId<HTMLElement>('volIcon')
  const volumeSlider = byId<HTMLInputElement>('volumeSlider')
  const btnFullscreen = byId<HTMLButtonElement>('btnFullscreen')
  const btnTheater = byId<HTMLButtonElement>('btnTheater')
  // Theater fit popover — null on any page that renders its own control bar.
  const btnTheaterFit = byId<HTMLButtonElement>('btnTheaterFit')
  const fitPopover = byId<HTMLElement>('theaterFitPopover')
  const fitStretchSlider = byId<HTMLInputElement>('theaterStretchSlider')
  const fitZoomSlider = byId<HTMLInputElement>('theaterZoomSlider')
  const fitStretchValue = byId<HTMLElement>('theaterStretchValue')
  const fitZoomValue = byId<HTMLElement>('theaterZoomValue')
  const fitHint = byId<HTMLElement>('theaterFitHint')
  const btnFitReset = byId<HTMLButtonElement>('btnTheaterFitReset')
  const progressWrap = byId<HTMLElement>('progressWrap')
  const seekTooltip = byId<HTMLElement>('progressTooltip')
  const seekTooltipTime = byId<HTMLElement>('progressTooltipTime')
  const seekTooltipThumb = byId<HTMLCanvasElement>('progressTooltipThumb')
  const zoomSliderEl = byId<HTMLInputElement>('zoomSlider')
  const speedSliderEl = byId<HTMLInputElement>('speedSlider')
  // Carries a ladder index, not a rate — see `./playbackRate`.
  const rateSliderEl = byId<HTMLInputElement>('playbackRateSlider')
  const rateValueEl = byId<HTMLElement>('playbackRateValue')
  const flipYBtn = byId<HTMLButtonElement>('flipYBtn') // null in playlist
  const pathBtn = byId<HTMLButtonElement>('pathBtn')
  // Theater playlist drawer — both null outside the playlist page.
  const btnPlaylistDrawer = byId<HTMLButtonElement>('btnPlaylistDrawer')
  const btnCloseDrawer = byId<HTMLButtonElement>('btnTheaterSidebarClose')
  const tapIndicator = byId<HTMLElement>('videoTapIndicator')
  const tapIndicatorIcon = byId<HTMLElement>('videoTapIndicatorIcon') // <svg>
  // Cached rather than looked up per call: theater's mousemove handler reaches
  // for both on every pointer event.
  const playerContainer = byId<HTMLElement>('playerContainer')
  const controlsBar = playerContainer.querySelector<HTMLElement>('.player-controls')

  const COLORS = buildColors(userSettings)

  // Mutable state
  let activePath: Float32Array | null = null
  let activeEffects: BxEffect[] = [] // bx2 effects array for the current path
  let activePeaks: number[] = [] // frame numbers of peak markers (for DH mode)
  let totalFrames = 14400
  let smoothTime = 0
  let lastRafTime: number | null = null
  let isOverlay = userSettings.defaultOverlay === true
  let overlayBg = userSettings.defaultOverlayBg === true
  // Live for the session, seeded from the persisted default and never written
  // back — how dark the scrim needs to be is a property of the video under it.
  let overlayBgOpacity = clampOpacity(userSettings.overlayBgOpacity)
  let flipY = userSettings.defaultFlipY === true
  // Purely a display switch — for videos that already have the path burned in.
  // The .bx stays loaded and `onFrame` keeps reporting, so device output and
  // the OSSM export are unaffected by it.
  let pathHidden = false
  /**
   * The rate the user asked for, held separately from `video.playbackRate`
   * because the element loses it: swapping `src` re-runs the media load
   * algorithm, which resets the live rate. This is what it gets put back to.
   */
  let liveRate = NORMAL_PLAYBACK_RATE
  let isSeeking = false
  let wasPlayingBeforeSeek = false
  let seekingLongTimer: ReturnType<typeof setTimeout> | null = null
  let scrubbing = false
  // Seek-bar hover readout. The bubble's width is only re-measured when its
  // text changes or its thumbnail appears, because pointermove fires at
  // trackpad rates and offsetWidth forces a layout every time it is read.
  let tooltipVisible = false
  let tooltipText = ''
  let tooltipWidth = 0
  // Last hover geometry, kept so the bubble can be re-clamped when a frame
  // lands and changes its width — which happens well after the pointermove
  // that asked for it.
  let tooltipCenterPx = 0
  let tooltipTrackW = 0
  // Frame preview. The decoding element is built on first hover and lives as
  // long as the track does; `previewFailed` latches so a video the browser
  // will not open a second decoder for is asked once, not once per pointermove.
  let previewVideo: HTMLVideoElement | null = null
  let previewSrc = ''
  let previewFailed = false
  let previewCtx: CanvasRenderingContext2D | null = null
  let previewSeek: PreviewSeekState = idlePreviewSeek()
  let previewStallTimer: ReturnType<typeof setTimeout> | null = null
  // Retires the preview element once the pointer has left the bar. Without it
  // the element is built on the first hover and holds its share of the media
  // cache until the track changes, which on a long file is the rest of the
  // session; see `PREVIEW_MAX_DURATION_SECS`.
  let previewIdleTimer: ReturnType<typeof setTimeout> | null = null
  let thumbShown = false
  let thumbW = 0
  let thumbH = 0
  let lastHoverSecs = 0
  let lastMinDelta = 1
  let hideControlsTimer: ReturnType<typeof setTimeout> | null = null
  let cursorTimer: ReturnType<typeof setTimeout> | null = null
  // Mirrors the `controls-visible` class. Read every rAF (the loop skips writing
  // to a bar nobody can see) and on every mousemove, so it is a flag rather than
  // a `classList.contains` call.
  let controlsVisible = false
  /** Last whole second written to the timecode, so repeats can be skipped. */
  let lastTimecodeSecs = -1
  /** Cached control-bar height; 0 means "re-measure on next raise". */
  let controlsBarH = 0
  /** Geometry last written by `applyTheaterFit`, so it can skip no-op writes. */
  let lastFitSig = ''
  let isTheater = false
  // The persisted starting point, and the live copy the popover drags. Kept
  // apart so Reset has something to go back to without re-reading storage.
  const storedLimits = {
    maxStretch: clampStretch(userSettings.theaterMaxStretch),
    maxZoom: clampZoom(userSettings.theaterMaxZoom),
  }
  const fitLimits = { ...storedLimits }

  // Teardown bookkeeping (not part of the legacy engine)
  const cleanups: Array<() => void> = []
  let destroyed = false
  let rafId = 0

  function on(
    target: EventTarget,
    type: string,
    handler: (e: never) => void,
    options?: AddEventListenerOptions,
  ) {
    const fn = handler as EventListener
    target.addEventListener(type, fn, options)
    cleanups.push(() => target.removeEventListener(type, fn, options))
  }

  // ── Zoom default ────────────────────────────────────────────────────────────
  const defaultZoom =
    typeof userSettings.defaultZoom === 'number' &&
    userSettings.defaultZoom >= 0.1 &&
    userSettings.defaultZoom <= 1.0
      ? userSettings.defaultZoom
      : 0.45
  zoomSliderEl.value = String(defaultZoom)

  const defaultPathSpeed =
    typeof userSettings.defaultPathSpeed === 'number' &&
    userSettings.defaultPathSpeed >= 0.5 &&
    userSettings.defaultPathSpeed <= 4.0
      ? userSettings.defaultPathSpeed
      : 1.0
  speedSliderEl.value = String(defaultPathSpeed)

  // ── Initial UI state ────────────────────────────────────────────────────────
  overlayBtn.textContent = `overlay: ${isOverlay ? 'on' : 'off'}`
  overlayBtn.classList.toggle('active', isOverlay)
  bxWrap.classList.toggle('overlay-mode', isOverlay)
  syncOverlayBgControls()
  if (flipYBtn) {
    flipYBtn.textContent = `flip Y: ${flipY ? 'on' : 'off'}`
    flipYBtn.classList.toggle('active', flipY)
  }
  applyPathHidden()

  // ── Volume: restore persisted state, else fall back to the saved default ───
  // The session value wins so tuning the level mid-playlist survives the track
  // change; the setting only decides where a fresh session starts.
  const savedVolume = sessionStorage.getItem('playerVolume')
  const savedMuted = sessionStorage.getItem('playerMuted')
  const defaultVolume =
    typeof userSettings.defaultVolume === 'number' &&
    userSettings.defaultVolume >= 0 &&
    userSettings.defaultVolume <= 1
      ? userSettings.defaultVolume
      : 0.5
  const startVolume = savedVolume !== null ? parseFloat(savedVolume) : defaultVolume
  video.volume = startVolume
  volumeSlider.value = String(startVolume)
  if (savedMuted !== null) {
    video.muted = savedMuted === 'true'
    if (video.muted) volumeSlider.value = '0'
  }
  updateVolIcon()

  // ── Canvas sizing ───────────────────────────────────────────────────────────
  function isFullscreen(): boolean {
    const d = document as FsDocument
    return !!(d.fullscreenElement || d.webkitFullscreenElement)
  }

  /**
   * Height the picture cannot use when it is scaled to the full window width —
   * the black bar a video wider than the window leaves behind. 0 when the video
   * is the taller of the two, which is the usual case on a 16:9 screen.
   */
  function letterboxSlack(): number {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh) return 0
    const fitted = Math.min(window.innerHeight, (window.innerWidth * vh) / vw)
    return Math.max(0, window.innerHeight - fitted)
  }

  /** Reference height the zoom slider scales the waveform against. */
  function getOverlayRefHeight(): number {
    if (isFullscreen()) return Math.round(window.innerHeight * 0.35)
    // Theater keeps the strip in the layout, so every pixel it takes is a pixel
    // off the picture. Spend the letterbox slack first — that part is free —
    // and fall back to a viewport-relative floor when there is none, so the
    // strip stays readable on a big screen instead of pinning to 200px.
    if (isTheater) {
      const floor = Math.max(
        BX_HEIGHT_OVERLAY,
        Math.round(window.innerHeight * BX_THEATER_MIN_VH),
      )
      return Math.round(
        Math.min(
          Math.max(letterboxSlack(), floor),
          window.innerHeight * BX_THEATER_MAX_VH,
        ),
      )
    }
    return BX_HEIGHT_OVERLAY
  }

  function resizeCanvas() {
    const w = bxWrap.clientWidth
    let h: number
    if (!isOverlay) {
      const refH = getOverlayRefHeight()
      const sliderValue = parseFloat(zoomSliderEl.value)
      const waveformPx = Math.min(2 * sliderValue * refH, refH)
      h = Math.round(waveformPx) + 2 * (BALL_R + 2)
    } else if (isFullscreen() || isTheater) {
      h = Math.round(window.innerHeight * BX_THEATER_MAX_VH)
    } else {
      h = BX_HEIGHT_OVERLAY
    }
    canvas.width = w || bxWrap.offsetWidth || 800
    canvas.height = h
    // Resizing clears the canvas, so it always needs a repaint. Catches the
    // ResizeObserver, fullscreen/theater transitions and the public API at once.
    scheduleFrame()
  }

  /**
   * Push the picture out into the pillarbox bars theater's stage leaves it.
   *
   * The geometry is the element's own box plus `object-fit: fill`, NOT a
   * `transform: scale()`. Both produce the identical picture — a `contain` fit
   * scaled by (sx, sy) is the same rectangle as a box of that size filled — but
   * a transformed `<video>` is disqualified from the platform's hardware video
   * overlay, so every decoded frame has to be uploaded and composited as a
   * texture instead of being scanned out directly. On an Intel MacBook Pro that
   * alone is the difference between theater dropping frames and fullscreen (no
   * transform, see the early return) running clean.
   *
   * The box is measured off the *wrap*, never off the video: the video's own
   * size is now an output of this function, so reading it back would wind the
   * stretch up on every call.
   */
  function applyTheaterFit() {
    const s = video.style
    if (!isTheater) {
      s.transform = ''
      s.flex = ''
      s.width = s.height = s.marginTop = s.marginBottom = s.objectFit = ''
      lastFitSig = ''
      return
    }
    const videoWrap = video.parentElement
    if (!videoWrap) return

    // What the flex column leaves the video: the wrap minus the strip below it.
    // The controls are absolutely positioned in theater, so they take no height.
    const boxW = videoWrap.clientWidth
    const boxH = videoWrap.clientHeight - bxWrap.offsetHeight
    const fit = theaterFit(boxW, boxH, video.videoWidth, video.videoHeight, fitLimits)
    reportFit(fit)

    // Unmeasurable yet — no metadata, or a box that has not been laid out.
    // Handing the element back to the stylesheet's `flex: 1 1 0` + `contain` is
    // the right picture for a video whose dimensions are not known, and it is
    // also the state this started in, so nothing flashes.
    const contain = Math.min(boxW / video.videoWidth, boxH / video.videoHeight)
    if (!Number.isFinite(contain) || contain <= 0) {
      s.flex = ''
      s.width = s.height = s.marginTop = s.marginBottom = s.objectFit = ''
      lastFitSig = ''
      return
    }

    // The `contain` fit the stylesheet would have drawn, scaled out to the fit.
    // At identity this is exactly what `object-fit: contain` produces, so the
    // sizing is unconditional and the element box is always the picture box.
    const picW = Math.round(video.videoWidth * contain * fit.scaleX)
    const picH = Math.round(video.videoHeight * contain * fit.scaleY)
    // Margins carry the centering AND keep the element's outer height equal to
    // `boxH`, so the strip below never moves — including when zoom overflows the
    // box and the margins go negative (the wrap clips the overhang).
    //
    // Whole pixels, with the bottom margin taking the remainder, so the three
    // sum to `boxH` EXACTLY. Rounding them independently leaves a sub-pixel
    // residue that squeezes the strip below, which resizes `bxWrap`, which
    // re-runs this from the ResizeObserver against a box a hair smaller than
    // last time — an oscillation that locks the tab up.
    const marginTop = Math.round((boxH - picH) / 2)
    const marginBottom = boxH - picH - marginTop
    // Writing the same geometry again would dirty layout for nothing, and this
    // runs from a ResizeObserver — a no-op write is how a feedback loop starts.
    const sig = `${picW}/${picH}/${marginTop}/${marginBottom}`
    if (sig === lastFitSig) return
    lastFitSig = sig

    // `flex` inline rather than in the stylesheet: the CSS rule has to keep
    // `flex: 1 1 0` as its no-JS floor (see globals.css), so the override that
    // stops flex fighting the height below belongs here.
    s.flex = '0 0 auto'
    s.width = `${picW}px`
    s.height = `${picH}px`
    s.marginTop = `${marginTop}px`
    s.marginBottom = `${marginBottom}px`
    s.objectFit = 'fill'
  }

  // ── Canvas rendering ────────────────────────────────────────────────────────
  /** Frame index and interpolated depth under the playhead. */
  function sampleAtPlayhead(path: Float32Array) {
    const curFrameExact = Math.min(
      (smoothTime - offsetSecs) * FPS,
      totalFrames - 1,
    )
    const curFrame = Math.floor(curFrameExact)
    const frac = curFrameExact - curFrame
    const depthA = curFrame >= 0 && path[curFrame] >= 0 ? path[curFrame] : 0
    const depthB =
      curFrame >= 0
        ? path[Math.min(curFrame + 1, totalFrames - 1)] >= 0
          ? path[Math.min(curFrame + 1, totalFrames - 1)]
          : depthA
        : 0
    const curDepth = depthA + (depthB - depthA) * (curFrame >= 0 ? frac : 0)
    return { curFrameExact, curFrame, curDepth }
  }

  function drawBounceX() {
    if (!activePath) return
    const path = activePath

    // Hidden: skip the paint but keep sampling, so the device driver and
    // anything else on `onFrame` see an unbroken stream of depths.
    if (pathHidden) {
      if (onFrame) {
        const s = sampleAtPlayhead(path)
        onFrame(s.curFrame, s.curDepth)
      }
      return
    }

    const W = canvas.width,
      H = canvas.height
    if (W === 0 || H === 0) return

    ctx.clearRect(0, 0, W, H)

    const { curFrameExact, curFrame, curDepth } = sampleAtPlayhead(path)
    const ballX = W / 2
    const sliderValue = parseFloat(zoomSliderEl.value)
    const BALL_MARGIN = BALL_R + 2

    let topY: number, bottomY: number
    if (isOverlay) {
      // Overlay: bottom is anchored to canvas bottom; zoom raises the top edge
      bottomY = H - BALL_MARGIN
      topY = Math.max(BALL_MARGIN, H * (1 - 2 * sliderValue))
    } else {
      // Normal: canvas height is already sized to the zoom level by resizeCanvas()
      topY = BALL_MARGIN
      bottomY = H - BALL_MARGIN
    }

    // Clip so nothing renders within EDGE_PAD of the canvas edges
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, EDGE_PAD, W, isOverlay ? H - EDGE_PAD : H - EDGE_PAD * 2)
    ctx.clip()

    const displayDepth = flipY ? 1 - curDepth : curDepth
    const ballY = bottomY + displayDepth * (topY - bottomY)
    const isNearTop = flipY ? curDepth <= 0.01 : curDepth >= 0.99
    const isNearBottom = flipY ? curDepth >= 0.99 : curDepth <= 0.01
    const isDH = userSettings.dhMode === true

    // Boundary lines
    ctx.lineWidth = 1
    ctx.strokeStyle = !isDH && isNearTop ? COLORS.topActive : COLORS.topLine
    ctx.beginPath()
    ctx.moveTo(0, topY)
    ctx.lineTo(W, topY)
    ctx.stroke()
    ctx.strokeStyle =
      !isDH && isNearBottom ? COLORS.bottomActive : COLORS.bottomLine
    ctx.beginPath()
    ctx.moveTo(0, bottomY)
    ctx.lineTo(W, bottomY)
    ctx.stroke()

    // Waveform path with horizontal fade gradient
    // Per-frame speed integration: each frame's x is computed by accumulating
    // (pxPerFrame * speedAt(f)) from the playhead outward, so only frames inside
    // a speed effect zone get stretched — frames outside stay at normal spacing.
    const basePixPerFrame = PX_PER_FRAME * parseFloat(speedSliderEl.value)

    function viewerSpeedAt(f: number): number {
      if (userSettings.effectsSpeedEnabled === false) return 1.0
      let s = 1.0
      for (const ef of activeEffects) {
        if (ef.type !== 'pathSpeed') continue
        const fade = getEffectFadeAlpha(ef, f)
        if (fade <= 0) continue
        s = 1.0 + ((ef.speed || 1.0) - 1.0) * fade
      }
      return s
    }

    const visRange = Math.ceil(W / basePixPerFrame) + 4
    const vMaxF = Math.min(totalFrames - 1, Math.ceil(curFrameExact) + visRange)
    const vMinF = Math.max(0, Math.floor(curFrameExact) - visRange)

    // The integration only earns its keep while a pathSpeed zone is actually
    // stretching the spacing; with every step at 1.0 the accumulation is just a
    // count of basePixPerFrame. A full-width strip is ~1300 frames, so leaving it
    // in meant allocating a Map and filling it every frame to say "no change".
    // activeEffects is empty for every path in this library, so the test is a
    // `.some()` over an empty array.
    const speedScaled =
      userSettings.effectsSpeedEnabled !== false &&
      activeEffects.some((ef) => ef.type === 'pathSpeed')

    let viewerFrameToX: (f: number) => number

    if (!speedScaled) {
      // Closed form, deliberately reproducing the accumulation's quirks rather
      // than the "obvious" ballX + (f - curFrameExact) * pxPerFrame: the first
      // step out of the playhead is charged as a WHOLE frame in both directions,
      // which is what quantises the strip to frame boundaries instead of letting
      // it scroll sub-frame, and frames outside the accumulated window are the one
      // place exact distance from curFrameExact is used.
      const cfCeil = Math.ceil(curFrameExact)
      const cfFloor = Math.floor(curFrameExact)
      // On an integer playhead the rightward pass overwrites the playhead's own
      // slot, so the leftward pass skips it and lands one frame short.
      const leftBias = cfCeil === cfFloor ? 0 : 1
      const xAt = (n: number): number => {
        if (n >= cfCeil && n <= vMaxF)
          return ballX + (n - cfCeil + 1) * basePixPerFrame
        if (n <= cfFloor && n >= vMinF)
          return ballX - (cfFloor - n + leftBias) * basePixPerFrame
        return ballX + (n - curFrameExact) * basePixPerFrame
      }
      viewerFrameToX = (f) => {
        // A fractional playhead keeps its own exact key at ballX; an integer one
        // does not, having been overwritten above.
        if (leftBias === 1 && f === curFrameExact) return ballX
        const fl = Math.floor(f),
          fr = Math.ceil(f)
        const xl = xAt(fl)
        return xl + (xAt(fr) - xl) * (f - fl)
      }
    } else {
      const viewerXCache = new Map<number, number>()
      viewerXCache.set(curFrameExact, ballX)

      let xAccR = ballX
      for (let f = Math.ceil(curFrameExact); f <= vMaxF; f++) {
        xAccR += basePixPerFrame * viewerSpeedAt(f - 0.5)
        viewerXCache.set(f, xAccR)
      }
      let xAccL = ballX
      for (let f = Math.floor(curFrameExact); f >= vMinF; f--) {
        if (!viewerXCache.has(f)) {
          xAccL -= basePixPerFrame * viewerSpeedAt(f + 0.5)
          viewerXCache.set(f, xAccL)
        }
      }
      viewerFrameToX = (f) => {
        if (viewerXCache.has(f)) return viewerXCache.get(f) as number
        const fl = Math.floor(f),
          fr = Math.ceil(f)
        const xl =
          viewerXCache.get(fl) ?? ballX + (fl - curFrameExact) * basePixPerFrame
        const xr =
          viewerXCache.get(fr) ?? ballX + (fr - curFrameExact) * basePixPerFrame
        return xl + (xr - xl) * (f - fl)
      }
    }

    const startFrame = vMinF
    const endFrame = vMaxF

    const { pathRgb, ballRgb, bgRgb } = getEffectiveColorRgb(
      activeEffects,
      curFrameExact,
      COLORS.pathColor,
      COLORS.ball,
      userSettings,
      userSettings.bgColor || '#0a0b0f',
    )
    const [pr, pg, pb] = pathRgb

    // Background — use effect bgColor if active, else user setting
    const bgAlpha = userSettings.bgTransparent !== false ? 0.45 : 1.0
    if (!isOverlay) {
      const [bgR, bgG, bgB] =
        bgRgb || hexToRgbArr(userSettings.bgColor || '#0a0b0f')
      ctx.fillStyle = `rgba(${bgR},${bgG},${bgB},${bgAlpha})`
      ctx.fillRect(0, 0, W, H)
    } else if (overlayBg && overlayBgOpacity > 0) {
      const [bgR, bgG, bgB] =
        bgRgb || hexToRgbArr(userSettings.bgColor || '#0a0b0f')
      ctx.fillStyle = `rgba(${bgR},${bgG},${bgB},${overlayBgOpacity})`
      ctx.fillRect(0, topY, W, H - topY)
    }

    // ── DH Mode ─────────────────────────────────────────────────────────────────
    if (isDH) {
      const midY = (topY + bottomY) / 2
      const circleR = Math.max(BALL_R + 3, (bottomY - topY) * 0.13)

      // Vertical hit line at center
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 5])
      ctx.beginPath()
      ctx.moveTo(ballX, topY + 2)
      ctx.lineTo(ballX, bottomY - 2)
      ctx.stroke()
      ctx.setLineDash([])

      // Static hit ring at center
      ctx.beginPath()
      ctx.arc(ballX, midY, circleR, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,255,255,0.28)'
      ctx.lineWidth = 2
      ctx.stroke()

      // Scrolling peak circles
      for (const pf of activePeaks) {
        const x = viewerFrameToX(pf)
        if (x < -circleR * 4 || x > W + circleR * 4) continue

        const dist = Math.abs(x - ballX)
        const hitFrac = Math.max(0, 1 - dist / (circleR * 5))

        // Glow halo when near hit line
        if (hitFrac > 0) {
          const glow = ctx.createRadialGradient(
            x,
            midY,
            0,
            x,
            midY,
            circleR * 3.5,
          )
          glow.addColorStop(0, `rgba(${pr},${pg},${pb},${0.32 * hitFrac})`)
          glow.addColorStop(1, `rgba(${pr},${pg},${pb},0)`)
          ctx.beginPath()
          ctx.arc(x, midY, circleR * 3.5, 0, Math.PI * 2)
          ctx.fillStyle = glow
          ctx.fill()
        }

        // Fill circle progressively as it approaches hit line
        if (hitFrac > 0.4) {
          ctx.beginPath()
          ctx.arc(x, midY, circleR, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${pr},${pg},${pb},${((hitFrac - 0.4) / 0.6) * 0.85})`
          ctx.fill()
        }

        // Circle outline — brighter when near
        ctx.beginPath()
        ctx.arc(x, midY, circleR, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${pr},${pg},${pb},${0.45 + hitFrac * 0.55})`
        ctx.lineWidth = 2.5
        ctx.stroke()
      }
    } else {
      // ── Normal waveform ──────────────────────────────────────────────────────────
      const pathGrad = ctx.createLinearGradient(0, 0, W, 0)
      pathGrad.addColorStop(0, `rgba(${pr},${pg},${pb},0)`)
      pathGrad.addColorStop(0.15, `rgba(${pr},${pg},${pb},0.6)`)
      pathGrad.addColorStop(0.45, `rgba(${pr},${pg},${pb},1)`)
      pathGrad.addColorStop(0.55, `rgba(${pr},${pg},${pb},1)`)
      pathGrad.addColorStop(0.85, `rgba(${pr},${pg},${pb},0.6)`)
      pathGrad.addColorStop(1, `rgba(${pr},${pg},${pb},0)`)

      ctx.strokeStyle = pathGrad
      ctx.lineWidth = 2.5
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      let pathStarted = false
      for (let f = startFrame; f <= endFrame; f++) {
        const d = path[f]
        if (d < 0) continue
        const x = viewerFrameToX(f)
        const displayD = flipY ? 1 - d : d
        const y = bottomY + displayD * (topY - bottomY)
        if (!pathStarted) {
          ctx.moveTo(x, y)
          pathStarted = true
        } else ctx.lineTo(x, y)
      }
      if (pathStarted) ctx.stroke()

      // Ball glow
      const glowGrad = ctx.createRadialGradient(
        ballX,
        ballY,
        0,
        ballX,
        ballY,
        BALL_R * 3,
      )
      glowGrad.addColorStop(0, 'rgba(255,255,255,0.35)')
      glowGrad.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.beginPath()
      ctx.arc(ballX, ballY, BALL_R * 3, 0, Math.PI * 2)
      ctx.fillStyle = glowGrad
      ctx.fill()

      // Ball
      ctx.beginPath()
      ctx.arc(ballX, ballY, BALL_R, 0, Math.PI * 2)
      ctx.fillStyle = `rgb(${ballRgb[0]},${ballRgb[1]},${ballRgb[2]})`
      ctx.fill()
    } // end normal waveform / DH mode branch

    // Playhead line (outside clip, spans full height)
    ctx.restore()
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(ballX, 0)
    ctx.lineTo(ballX, H)
    ctx.stroke()
    ctx.setLineDash([])

    // ── Text effects (bx2) ────────────────────────────────────────────────────
    if (userSettings.effectsTextEnabled !== false) {
      for (const ef of activeEffects) {
        if (ef.type !== 'text') continue
        const fadeAlpha =
          getEffectFadeAlpha(ef, curFrameExact) * (ef.opacity ?? 1)
        if (fadeAlpha <= 0) continue
        const fontFamily = ef.font || 'sans-serif'
        // pathAreaH = bottomY - topY; font scales with it so overlay/zoom work
        const pathAreaH = bottomY - topY
        let actualFontSize = Math.max(
          4,
          Math.round(((ef.fontSize || 50) / 100) * pathAreaH),
        )
        const tx = W * ((ef.posX ?? 50) / 100)
        const ty = topY + pathAreaH * ((ef.posY ?? 50) / 100)
        ctx.save()
        ctx.globalAlpha = fadeAlpha
        ctx.textAlign = 'center'
        ctx.textBaseline = 'alphabetic'
        ctx.fillStyle = ef.color || '#ffffff'
        ctx.shadowColor = 'rgba(0,0,0,0.8)'

        const lines = String(ef.text || '').split('\n')
        const maxAllowedW = W * 0.92 // 4% margin each side

        // Measure at nominal size, shrink font if widest line overflows
        ctx.font = `${actualFontSize}px '${fontFamily}', 'JetBrains Mono', sans-serif`
        const widestLine = lines.reduce(
          (max, l) => Math.max(max, ctx.measureText(l).width),
          0,
        )
        if (widestLine > maxAllowedW) {
          actualFontSize = Math.max(
            4,
            Math.floor((actualFontSize * maxAllowedW) / widestLine),
          )
          ctx.font = `${actualFontSize}px '${fontFamily}', 'JetBrains Mono', sans-serif`
        }

        ctx.shadowBlur = Math.max(2, Math.ceil(actualFontSize / 10))
        // Use actual glyph metrics for precise vertical centering
        const m = ctx.measureText('Ag')
        const vAsc = m.actualBoundingBoxAscent ?? actualFontSize * 0.72
        const vDesc = m.actualBoundingBoxDescent ?? actualFontSize * 0.18
        const baselineAdjust = vAsc - (vAsc + vDesc) / 2
        const lineH = actualFontSize * 1.25
        const rawStrokeW = ef.strokeWidth || 0
        const strokeW =
          rawStrokeW > 0 ? (rawStrokeW / 100) * actualFontSize * 2 : 0
        lines.forEach((line, li) => {
          const lineCenterY = ty + (li - (lines.length - 1) / 2) * lineH
          if (strokeW > 0) {
            ctx.strokeStyle = ef.strokeColor || '#000000'
            ctx.lineWidth = strokeW
            ctx.lineJoin = 'round'
            ctx.shadowBlur = 0
            ctx.strokeText(line, tx, lineCenterY + baselineAdjust)
            ctx.shadowBlur = Math.max(2, Math.ceil(actualFontSize / 10))
          }
          ctx.fillText(line, tx, lineCenterY + baselineAdjust)
        })
        ctx.restore()
      }
    }

    if (onFrame) onFrame(curFrame, curDepth)
  }

  // ── RAF loop ────────────────────────────────────────────────────────────────
  /**
   * The loop only keeps itself alive while something is actually moving; when
   * it stops, the canvas simply keeps whatever the last frame painted. So
   * anything that changes what `drawBounceX` would paint has to call
   * `scheduleFrame()` — previously a frame was always about to run and picked
   * every change up for free.
   *
   * Watch the two sliders in particular: `drawBounceX` reads their values
   * straight out of the DOM rather than from state, so they need `input`
   * handlers of their own.
   */
  function needsContinuousFrame(): boolean {
    return (!video.paused && !video.ended) || isSeeking || scrubbing
  }

  function scheduleFrame() {
    if (destroyed || rafId) return
    rafId = requestAnimationFrame(loop)
  }

  function loop(rafTime: number) {
    rafId = 0
    if (destroyed) return
    if (!isSeeking) {
      if (!video.paused && !video.ended) {
        if (lastRafTime !== null) {
          // Scaled by the rate: this integrates *media* time from wall time, so
          // at 2× a 16 ms frame has advanced the video 32 ms. Without it the
          // ball lags the picture and the 0.1 s guard below thrashes, snapping
          // it back several times a second.
          const delta = ((rafTime - lastRafTime) / 1000) * video.playbackRate
          smoothTime += delta
          if (Math.abs(smoothTime - video.currentTime) > 0.1)
            smoothTime = video.currentTime
        } else {
          smoothTime = video.currentTime
        }
      } else {
        smoothTime = video.currentTime
      }
    }
    lastRafTime = rafTime

    // Immersive modes keep the bar off screen most of the time, and writing a
    // width, a left and a timecode into it every frame dirtied style on a
    // subtree nobody was looking at. `showControls` repaints it on the way back
    // up, so nothing is stale by the time it is visible.
    if (controlsVisible || !isImmersive()) {
      const t = isSeeking ? smoothTime : video.currentTime || 0
      const dur = video.duration || totalFrames / FPS
      const pct = dur > 0 ? (t / dur) * 100 : 0
      progressFill.style.width = `${pct}%`
      progressThumb.style.left = `${pct}%`
      // Timecode resolution is one second; at 60fps the other 59 writes were
      // rebuilding the identical string.
      const secs = Math.floor(t)
      if (secs !== lastTimecodeSecs) {
        lastTimecodeSecs = secs
        // Formatted against `dur` — the video's own length, which is what the
        // hover bubble measures too. The two readouts sit inches apart, so one
        // reading 101:06 while the other reads 1:41:06 is worse than either.
        timeDisplay.textContent = formatTimeDisplay(t, totalFrames / FPS, dur)
      }
    }

    drawBounceX()
    if (needsContinuousFrame()) scheduleFrame()
    // Dropping the timestamp makes the next run re-sync `smoothTime` to
    // `currentTime` instead of integrating the whole idle gap.
    else lastRafTime = null
  }

  // ── Overlay toggles ─────────────────────────────────────────────────────────
  /**
   * Hiding the strip takes the whole wrap out of the layout — in normal mode the
   * video gets those pixels back, and in overlay mode nothing is painted over
   * it. The strip's own options (overlay, bg, flip Y) go dead while it is off
   * screen rather than disappearing, so the row does not shift under the cursor.
   */
  function applyPathHidden() {
    if (pathBtn) {
      pathBtn.textContent = `path: ${pathHidden ? 'hidden' : 'shown'}`
      pathBtn.classList.toggle('active', pathHidden)
    }
    bxWrap.classList.toggle('path-hidden', pathHidden)
    overlayBtn.disabled = pathHidden
    overlayBgBtn.disabled = pathHidden
    if (overlayBgOpacitySlider) overlayBgOpacitySlider.disabled = pathHidden
    if (flipYBtn) flipYBtn.disabled = pathHidden
  }

  if (pathBtn) {
    on(pathBtn, 'click', () => {
      pathHidden = !pathHidden
      applyPathHidden()
      // Coming back needs the canvas re-measured: it was sized against a
      // display:none wrap while hidden.
      resizeCanvas()
      if (isFullscreen()) anchorOverlay()
    })
  }

  /**
   * The bg button only means anything in overlay mode, and its opacity slider
   * only means anything once the bg is on — so both follow the state above
   * them rather than sitting there inert.
   */
  function syncOverlayBgControls() {
    overlayBgBtn.style.display = isOverlay ? '' : 'none'
    overlayBgBtn.textContent = `bg: ${overlayBg ? 'on' : 'off'}`
    overlayBgBtn.classList.toggle('active', overlayBg)
    if (overlayBgOpacityWrap)
      overlayBgOpacityWrap.style.display = isOverlay && overlayBg ? '' : 'none'
    if (overlayBgOpacitySlider)
      overlayBgOpacitySlider.value = String(overlayBgOpacity)
    if (overlayBgOpacityValue)
      overlayBgOpacityValue.textContent = `${Math.round(overlayBgOpacity * 100)}%`
  }

  on(overlayBtn, 'click', () => {
    isOverlay = !isOverlay
    overlayBtn.textContent = `overlay: ${isOverlay ? 'on' : 'off'}`
    overlayBtn.classList.toggle('active', isOverlay)
    bxWrap.classList.toggle('overlay-mode', isOverlay)
    syncOverlayBgControls()
    resizeCanvas()
    if (isFullscreen()) anchorOverlay()
  })

  on(overlayBgBtn, 'click', () => {
    overlayBg = !overlayBg
    syncOverlayBgControls()
    scheduleFrame()
  })

  if (overlayBgOpacitySlider) {
    on(overlayBgOpacitySlider, 'input', () => {
      overlayBgOpacity = clampOpacity(parseFloat(overlayBgOpacitySlider.value))
      syncOverlayBgControls()
      scheduleFrame()
    })
  }

  if (flipYBtn) {
    on(flipYBtn, 'click', () => {
      flipY = !flipY
      flipYBtn.textContent = `flip Y: ${flipY ? 'on' : 'off'}`
      flipYBtn.classList.toggle('active', flipY)
      scheduleFrame()
    })
  }

  // Both sliders are read out of the DOM inside `drawBounceX`, so a change is
  // invisible until a frame runs. In overlay mode zoom doesn't resize the
  // canvas, and speed never did — hence the explicit repaints.
  on(zoomSliderEl, 'input', () => {
    if (!isOverlay) resizeCanvas()
    else scheduleFrame()
  })

  on(speedSliderEl, 'input', () => {
    scheduleFrame()
  })

  // ── Playback controls ───────────────────────────────────────────────────────
  /**
   * YouTube-style flash: the glyph for the state just entered, scaled up and
   * faded out. Driven from togglePlay rather than the video's play/pause events
   * because the seek handler pauses and resumes internally — that must not
   * flash. Removing the class and reading offsetWidth restarts the animation
   * when clicks come faster than it runs.
   */
  function flashTapIndicator(playing: boolean) {
    tapIndicatorIcon.innerHTML = playing ? PLAY_GLYPH : PAUSE_GLYPH
    tapIndicator.classList.toggle('is-play', playing)
    tapIndicator.classList.remove('flash')
    void tapIndicator.offsetWidth
    tapIndicator.classList.add('flash')
  }

  function togglePlay() {
    const willPlay = video.paused
    if (willPlay) video.play()
    else video.pause()
    flashTapIndicator(willPlay)
  }

  on(btnPlay, 'click', togglePlay)
  on(video, 'click', togglePlay)

  /**
   * The icon is derived from `video.paused`, never from which event fired.
   * `loadTrack` swaps `video.src` under a live engine, and the media load
   * algorithm sets `paused` there with no `pause` event of its own, so handlers
   * that each hardcode one face leave the button showing the previous track's
   * state. Every event below is only a hint to re-read the element; as with the
   * frame loop, `timeupdate` is the backstop that heals a missed one.
   */
  function syncPlayIcon() {
    if (!playIcon) return
    playIcon.innerHTML = video.paused ? PLAY_GLYPH : PAUSE_GLYPH
    playIcon.setAttribute('fill', 'currentColor')
  }
  for (const evt of [
    'play',
    'playing',
    'pause',
    'ended',
    'emptied',
    'loadstart',
    'canplay',
    'seeked',
    'waiting',
    'stalled',
    'timeupdate',
  ]) {
    on(video, evt, syncPlayIcon)
  }
  syncPlayIcon()

  on(video, 'ended', () => {
    if (onEnded) onEnded()
  })

  on(btnRewind, 'click', () => {
    video.currentTime = Math.max(0, video.currentTime - 5)
  })
  on(btnForward, 'click', () => {
    video.currentTime = Math.min(video.duration || 0, video.currentTime + 5)
  })

  // ── Frame stepping ──────────────────────────────────────────────────────────
  /**
   * A video element exposes no frame rate, so stepping one frame means
   * measuring one first. `requestVideoFrameCallback` fires once per presented
   * frame with that frame's exact presentation time; the *smallest* gap between
   * consecutive presentations is the frame duration. Taking the minimum rather
   * than an average is deliberate: a dropped frame (the Intel MacBook's failure
   * mode) only ever widens a gap, so it can pull an average down to a
   * plausible-looking wrong rate but can never fake a gap that is too short.
   *
   * Firefox has no rVFC, and neither does a track that has never been played,
   * so 30fps is the standing fallback: the step is then approximate, but ← / →
   * still move by something frame-sized instead of doing nothing.
   */
  const FALLBACK_FPS = 30
  const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120]
  /** Seeks land mid-frame, never on a PTS boundary; see `stepFrame`. */
  const FRAME_EPSILON = 1e-4
  const MIN_FRAME_SAMPLES = 12

  type VideoFrameMeta = { mediaTime: number; presentedFrames: number }
  type FrameCallbackVideo = HTMLVideoElement & {
    requestVideoFrameCallback?: (
      cb: (now: number, meta: VideoFrameMeta) => void,
    ) => number
    cancelVideoFrameCallback?: (handle: number) => void
  }
  const frameVideo = video as FrameCallbackVideo

  let detectedFps = 0
  let minFrameDelta = 0
  let frameSampleCount = 0
  let lastPresentedTime = -1
  let frameCallbackId = 0

  /** Measurement is within a percent or so; real rates are a short list. */
  function snapFps(measured: number): number {
    let best = measured
    let bestErr = 0.03
    for (const candidate of COMMON_FPS) {
      const err = Math.abs(candidate - measured) / candidate
      if (err < bestErr) {
        bestErr = err
        best = candidate
      }
    }
    return best
  }

  function onPresentedFrame(_now: number, meta: VideoFrameMeta) {
    frameCallbackId = 0
    // Re-seed the playhead from the frame ACTUALLY ON SCREEN. `smoothTime` is a
    // wall-clock integrator that is otherwise only corrected once it is more
    // than 0.1 s out — six frames at 60 — and it re-seeds to a fresh arbitrary
    // residual on every seek, so the error also differs per track in a
    // compilation. That slack is several times larger than anything in the .bx
    // files it draws, and it is what makes a correct path read as trailing the
    // picture and drifting. `mediaTime` is the presentation timestamp of the
    // presented frame, so it is the one clock that agrees with a path burnt
    // into that same frame — which is how the error was found. The integrator
    // stays: it carries the ball between presentations on a display refreshing
    // faster than the video, and it is the whole fallback on Firefox, which has
    // no rVFC.
    if (!isSeeking && !video.paused && !video.ended) smoothTime = meta.mediaTime
    // Only real-time playback measures anything: a seek presents one frame out
    // of nowhere, and a rate change scales media time against wall time.
    if (!video.paused && !video.ended && video.playbackRate === 1) {
      if (lastPresentedTime >= 0) {
        const delta = meta.mediaTime - lastPresentedTime
        // Above 1ms discards a repeat presentation of the same frame; below
        // half a second discards the jump either side of a stall.
        if (delta > 0.001 && delta < 0.5) {
          if (!minFrameDelta || delta < minFrameDelta) minFrameDelta = delta
          frameSampleCount++
          if (frameSampleCount >= MIN_FRAME_SAMPLES)
            detectedFps = snapFps(1 / minFrameDelta)
        }
      }
      lastPresentedTime = meta.mediaTime
    } else {
      lastPresentedTime = -1
    }
    requestFrameSample()
  }

  function requestFrameSample() {
    if (destroyed || frameCallbackId || !frameVideo.requestVideoFrameCallback)
      return
    frameCallbackId = frameVideo.requestVideoFrameCallback(onPresentedFrame)
  }
  requestFrameSample()

  // A new source is a new frame rate; the old measurement would be a lie.
  on(video, 'loadstart', () => {
    detectedFps = 0
    minFrameDelta = 0
    frameSampleCount = 0
    lastPresentedTime = -1
    requestFrameSample()
  })

  /**
   * Step exactly one frame. The target is offset by a hair so it lands *inside*
   * the neighbouring frame rather than on the boundary between the two: seeking
   * to an exact presentation timestamp is a coin flip once float error is in
   * play, and losing that flip re-presents the frame already on screen, which
   * reads as a dead key.
   */
  function stepFrame(direction: 1 | -1) {
    const frameDur = 1 / (detectedFps || FALLBACK_FPS)
    // Stepping is a paused-only idea, so a step out of playback pauses first,
    // same as the transport's own tap, hence the flash to explain the stop.
    if (!video.paused) {
      video.pause()
      flashTapIndicator(false)
    }
    const target = video.currentTime + direction * frameDur + FRAME_EPSILON
    const end = Number.isFinite(video.duration) ? video.duration : target
    video.currentTime = Math.min(end, Math.max(0, target))
  }

  /**
   * Transport, volume and track keys. Every one of these has a button too —
   * these exist because the player is used full-screen, where the buttons are
   * hidden behind a pointer move to the bottom edge.
   *
   * `e.code` for the physical keys (Space, arrows) and `e.key` for the letters,
   * so the letters follow the user's layout instead of a US keyboard's.
   *
   * Shift is load-bearing rather than ignored: it is what separates the track
   * keys from the plain letters next to them, so an unshifted binding has to
   * say so or Shift+P would toggle the drawer on its way to the previous track.
   */
  on(document, 'keydown', (e: KeyboardEvent) => {
    if (isTypingTarget(e)) return
    const key = e.key.toLowerCase()
    if (e.code === 'Space') {
      e.preventDefault()
      togglePlay()
    }
    // Shift turns the seek keys into frame steps. Nothing else claims
    // Shift+←/→ over a video (the browser's own binding there is caret
    // selection, which needs a caret), and it keeps the two scrub sizes on the
    // same pair of keys instead of inventing a second pair.
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      const direction = e.code === 'ArrowRight' ? 1 : -1
      if (e.shiftKey) {
        e.preventDefault()
        stepFrame(direction)
      } else {
        const target = Math.max(0, video.currentTime + direction * 5)
        video.currentTime = Number.isFinite(video.duration)
          ? Math.min(video.duration, target)
          : target
      }
    }
    // The arrows would scroll the page out from under the player otherwise.
    if (e.code === 'ArrowUp') {
      e.preventDefault()
      setVolume(video.volume + 0.05)
    }
    if (e.code === 'ArrowDown') {
      e.preventDefault()
      setVolume(video.volume - 0.05)
    }
    if (key === 'm' && !e.shiftKey) toggleMute()
    // mpv's bindings, and the only bracket keys the player wants. Matched on
    // `e.key` rather than `key`, so the shifted `{` / `}` fall through instead
    // of stepping the rate on their way somewhere else.
    if (e.key === '[') setPlaybackRate(stepRate(liveRate, -1))
    if (e.key === ']') setPlaybackRate(stepRate(liveRate, 1))
    if (e.key === '\\') setPlaybackRate(NORMAL_PLAYBACK_RATE)
    // Shift+F is the fit popover, and it is theater's to handle.
    if (key === 'f' && !e.shiftKey) toggleFullscreen()
    if (key === 'n' && e.shiftKey && btnNextTrack) btnNextTrack.click()
    if (key === 'p' && e.shiftKey && btnPrevTrack) btnPrevTrack.click()
  })

  // ── Video state events ──────────────────────────────────────────────────────
  on(video, 'seeking', () => {
    isSeeking = true
    wasPlayingBeforeSeek = !video.paused
    video.pause()
    if (seekingLongTimer) clearTimeout(seekingLongTimer)
    seekingLongTimer = setTimeout(() => {
      seekingLongTimer = null
    }, 2500)
    if (onSeeking) onSeeking()
  })

  on(video, 'seeked', () => {
    if (seekingLongTimer) clearTimeout(seekingLongTimer)
    seekingLongTimer = null
    isSeeking = false
    smoothTime = video.currentTime || 0
    if (wasPlayingBeforeSeek) video.play()
    if (onSeeked) onSeeked()
  })

  // Anything that can move the playhead or change what a frame would paint has
  // to wake the loop now that it stops when idle. `timeupdate` is the backstop
  // for programmatic `currentTime` writes the browser serves straight from
  // buffer without a `seeking` event.
  for (const evt of [
    'play',
    'pause',
    'ended',
    'seeking',
    'seeked',
    'timeupdate',
    'loadedmetadata',
    'loadeddata',
    'canplay',
    'durationchange',
    'ratechange',
  ]) {
    on(video, evt, scheduleFrame)
  }

  // The theater strip is sized from the video's own aspect ratio, so it has to
  // be recomputed as soon as the intrinsic dimensions are known — and again on
  // `resize`, which fires when a playlist swaps in a differently shaped track.
  // The fit is recomputed alongside it: a new aspect ratio changes how much
  // pillarbox there is to close without changing the layout box at all, so the
  // ResizeObserver would never hear about it.
  for (const evt of ['loadedmetadata', 'resize']) {
    on(video, evt, () => {
      resizeCanvas()
      applyTheaterFit()
    })
  }

  if (onCanPlay) on(video, 'canplay', onCanPlay)
  if (onWaiting) on(video, 'waiting', onWaiting)
  if (onPlaying) on(video, 'playing', onPlaying)
  if (onProgress) {
    on(video, 'progress', onProgress)
    on(video, 'loadedmetadata', onProgress)
  }

  // ── Volume ──────────────────────────────────────────────────────────────────
  // Slider, button and keyboard all land here rather than each doing their own
  // bookkeeping — the state is spread over four places (element volume, element
  // muted, the slider position and two sessionStorage keys) and drifted before.

  function persistVolume() {
    // `video.volume` rather than the slider: muting parks the slider at 0 but
    // has to remember the level to come back to.
    sessionStorage.setItem('playerVolume', String(video.volume))
    sessionStorage.setItem('playerMuted', String(video.muted))
  }

  function setVolume(v: number) {
    const next = Math.max(0, Math.min(1, v))
    video.volume = next
    // Raising the volume unmutes: leaving `muted` on would answer the keypress
    // with continued silence.
    video.muted = next === 0
    volumeSlider.value = String(next)
    persistVolume()
    updateVolIcon()
  }

  function toggleMute() {
    video.muted = !video.muted
    volumeSlider.value = String(video.muted ? 0 : video.volume)
    persistVolume()
    updateVolIcon()
  }

  on(volumeSlider, 'input', () => setVolume(parseFloat(volumeSlider.value)))
  on(btnMute, 'click', toggleMute)

  function updateVolIcon() {
    if (video.muted || video.volume === 0) {
      volIcon.innerHTML = `<polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>`
    } else {
      volIcon.innerHTML = `<polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M15.54,8.46a5,5,0,0,1,0,7.07"/><path d="M19.07,4.93a10,10,0,0,1,0,14.14"/>`
    }
  }

  // ── Playback rate ───────────────────────────────────────────────────────────
  // Same session/default split as volume: the live rate follows a playlist from
  // track to track so changing speed mid-list is not undone by the next track,
  // and the setting only decides where a fresh tab starts. Nothing here writes
  // back to settings — "what this video needs" and "what every video should
  // start at" are different questions, and the settings page owns the second.

  /**
   * Push a rate onto the element and the control, without persisting it.
   * `unknown` because both seeds are: a settings key an older install has never
   * written, and a `parseFloat` of whatever is in sessionStorage.
   */
  function applyRate(rate: unknown) {
    liveRate = clampRate(rate)
    // Both: `playbackRate` is the live one, `defaultPlaybackRate` is what the
    // element resets to when a new `src` is loaded. Setting only the first
    // drops a playlist back to 1× on its second track.
    video.defaultPlaybackRate = liveRate
    if (video.playbackRate !== liveRate) video.playbackRate = liveRate
    rateSliderEl.value = String(rateIndex(liveRate))
    rateValueEl.textContent = formatRate(liveRate)
  }

  function setPlaybackRate(rate: number) {
    applyRate(rate)
    sessionStorage.setItem('playerRate', String(liveRate))
  }

  const savedRate = sessionStorage.getItem('playerRate')
  applyRate(
    savedRate !== null ? parseFloat(savedRate) : userSettings.defaultPlaybackRate,
  )

  on(rateSliderEl, 'input', () =>
    setPlaybackRate(rateAt(parseFloat(rateSliderEl.value))),
  )

  // The reset above is spec'd behaviour, but a browser that skipped it would
  // leave the control and the element disagreeing with no way back. Cheap to
  // rule out, and it also catches a rate changed from outside the engine.
  on(video, 'loadedmetadata', () => {
    if (video.playbackRate !== liveRate) applyRate(liveRate)
  })

  // ── Progress bar scrubbing ──────────────────────────────────────────────────
  function seekTo(clientX: number) {
    const rect = progressWrap.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    video.currentTime = pct * (video.duration || 0)
  }

  /**
   * A drag fires at pointer rates (100+/sec on a trackpad) and every write to
   * `currentTime` abandons the range request in flight and opens another one.
   * Across a multi-GB carrier that is a few hundred aborted reads for one drag,
   * none of which can land. So the pointer is sampled instead: the newest
   * position waiting is served once a frame, and the ones swept past are
   * dropped, which is the same bargain `seekPreview.ts` already makes for the
   * bubble. A click still seeks immediately; it is only the drag that queues.
   */
  let pendingSeekX: number | null = null
  let seekRaf = 0
  function seekSoon(clientX: number) {
    pendingSeekX = clientX
    if (seekRaf) return
    seekRaf = requestAnimationFrame(() => {
      seekRaf = 0
      if (pendingSeekX !== null) seekTo(pendingSeekX)
      pendingSeekX = null
    })
  }
  cleanups.push(() => {
    if (seekRaf) cancelAnimationFrame(seekRaf)
    seekRaf = 0
    pendingSeekX = null
  })

  on(progressWrap, 'mousedown', (e: MouseEvent) => {
    scrubbing = true
    seekTo(e.clientX)
    scheduleFrame() // grabbing the thumb at the current position seeks nowhere
  })
  on(document, 'mousemove', (e: MouseEvent) => {
    if (scrubbing) seekSoon(e.clientX)
  })
  on(document, 'mouseup', () => {
    scrubbing = false
  })

  on(
    progressWrap,
    'touchstart',
    (e: TouchEvent) => {
      scrubbing = true
      if (e.touches.length) seekTo(e.touches[0].clientX)
      scheduleFrame()
    },
    { passive: true },
  )
  on(
    document,
    'touchmove',
    (e: TouchEvent) => {
      if (scrubbing && e.touches.length) seekSoon(e.touches[0].clientX)
    },
    { passive: true },
  )
  on(document, 'touchend', () => {
    scrubbing = false
  })

  // ── Seek-bar hover readout ──────────────────────────────────────────────────
  // Pointer events rather than mouse events so touch can be told apart: a
  // finger covers the bar it is scrubbing, so the bubble would be both useless
  // and in the way. Nothing here seeks or takes focus — it is display only, and
  // it runs beside the handlers above without touching them.
  function hideSeekTooltip() {
    if (!tooltipVisible) return
    tooltipVisible = false
    progressWrap.classList.remove('seek-tooltip-visible')
    schedulePreviewTeardown()
  }

  // ── Frame preview ───────────────────────────────────────────────────────────
  /** Box for the thumbnail. Big enough to recognise a shot in, still a bubble. */
  const PREVIEW_MAX_W = 256
  const PREVIEW_MAX_H = 160
  /**
   * …but never more than this much of the track it hangs over. On a phone the
   * full box is most of the bar's width, and a preview you have to seek around
   * is worse than a smaller one you can place.
   */
  const PREVIEW_MAX_TRACK_FRAC = 0.55
  /** A frame that has not arrived in this long is not arriving. */
  const PREVIEW_STALL_MS = 4000
  /**
   * How long a preview element outlives the hover that built it. Long enough
   * that sweeping off the bar and back does not pay for a rebuild, short enough
   * that the blocks it is holding come back before they are missed.
   */
  const PREVIEW_IDLE_MS = 5000
  /** A retina thumbnail is worth the pixels; a 3x one is not. */
  const PREVIEW_MAX_DPR = 2

  function clearPreviewStall() {
    if (!previewStallTimer) return
    clearTimeout(previewStallTimer)
    previewStallTimer = null
  }

  /**
   * Hand the position the coalescer picked to the element, and time it out.
   * A null pick leaves any running watchdog alone: the commonest null is "this
   * ask is queued behind a seek still in flight", and that seek is exactly the
   * one the watchdog is there to rescue.
   */
  function drivePreviewSeek(seekTo: number | null) {
    if (seekTo === null || !previewVideo) return
    clearPreviewStall()
    previewVideo.currentTime = seekTo
    previewStallTimer = setTimeout(() => {
      previewStallTimer = null
      // Release the slot so the next hover is not queued behind a seek that
      // never landed. `drew: false` keeps `drawn` on the frame really on
      // screen, so the abandoned position can be asked for again.
      const step = completePreviewSeek(previewSeek, lastMinDelta, false)
      previewSeek = step.state
      drivePreviewSeek(step.seekTo)
    }, PREVIEW_STALL_MS)
  }

  function hidePreviewThumb() {
    if (!thumbShown) return
    thumbShown = false
    seekTooltip.classList.remove('has-thumb')
    tooltipWidth = 0
    if (tooltipVisible) positionSeekTooltip()
  }

  function cancelPreviewTeardown() {
    if (!previewIdleTimer) return
    clearTimeout(previewIdleTimer)
    previewIdleTimer = null
  }

  /**
   * Hand the element's cache blocks back a few seconds after the bubble goes.
   * Scheduled from `hideSeekTooltip`, which every hide path funnels through, so
   * a pointer leaving the bar and a bar going down under it are both covered.
   */
  function schedulePreviewTeardown() {
    if (!previewVideo || previewIdleTimer) return
    previewIdleTimer = setTimeout(() => {
      previewIdleTimer = null
      // A drag that left the bar still owns the element it is drawing into.
      if (tooltipVisible || scrubbing) return
      teardownPreview()
    }, PREVIEW_IDLE_MS)
  }

  function teardownPreview() {
    clearPreviewStall()
    cancelPreviewTeardown()
    if (previewVideo) {
      previewVideo.removeEventListener('seeked', onPreviewSeeked)
      previewVideo.removeEventListener('loadedmetadata', onPreviewMetadata)
      previewVideo.removeEventListener('error', onPreviewError)
      // Drops the decoder and cancels the range request in flight. Without it a
      // playlist leaks one loading element per track it walks through.
      previewVideo.removeAttribute('src')
      previewVideo.load()
      previewVideo = null
    }
    previewSrc = ''
    previewCtx = null
    previewSeek = idlePreviewSeek()
    thumbW = 0
    thumbH = 0
    hidePreviewThumb()
  }

  function onPreviewError() {
    // A container the browser will open once but not twice, or a range server
    // that has stopped answering. Latch it: the bubble falls back to the bare
    // timecode for this track rather than retrying on every pointermove.
    previewFailed = true
    clearPreviewStall()
    previewSeek = idlePreviewSeek()
    hidePreviewThumb()
  }

  /** Seeks set before metadata never report back, so the first ask waits here. */
  function onPreviewMetadata() {
    if (tooltipVisible && !scrubbing) requestPreviewFrame()
  }

  function onPreviewSeeked() {
    clearPreviewStall()
    drawPreviewFrame()
    const step = completePreviewSeek(previewSeek, lastMinDelta)
    previewSeek = step.state
    drivePreviewSeek(step.seekTo)
  }

  /**
   * The element frames are decoded out of, built on first hover and rebuilt
   * whenever the track underneath changes.
   *
   * Deliberately never added to the document. An off-DOM video still loads,
   * seeks and hands frames to `drawImage`, but it is not composited — so it
   * cannot be the second video layer that costs the playing one its hardware
   * overlay, which is the whole performance budget on the Intel MacBook.
   */
  function ensurePreviewVideo(): HTMLVideoElement | null {
    const src = video.currentSrc || video.src
    if (!src) return null
    // Re-checked per hover rather than latched, because the duration this reads
    // arrives after the element does and a playlist can walk from a clip onto a
    // carrier.
    if (!previewWorthBuilding(video.duration)) {
      // Walking from a clip onto a carrier refuses the new element while the
      // clip's is still standing, and the bubble would go on showing a frame
      // out of the previous video until the idle timer got to it.
      if (previewSrc && previewSrc !== src) teardownPreview()
      return null
    }
    if (src === previewSrc) return previewFailed ? null : previewVideo
    teardownPreview()
    previewSrc = src
    previewFailed = false
    const pv = document.createElement('video')
    // `metadata`, not `auto`: the preview wants the few ranges it seeks into,
    // not a second copy of a file the main element is already streaming.
    pv.preload = 'metadata'
    pv.muted = true
    pv.playsInline = true
    pv.addEventListener('seeked', onPreviewSeeked)
    pv.addEventListener('loadedmetadata', onPreviewMetadata)
    pv.addEventListener('error', onPreviewError)
    pv.src = src
    previewVideo = pv
    return pv
  }

  function drawPreviewFrame() {
    const pv = previewVideo
    if (!pv) return
    // `tooltipTrackW` is whatever the last hover measured, so a window resize
    // re-caps the box on the next frame drawn rather than needing its own
    // listener. Zero only before the first hover, which cannot reach here.
    const maxW =
      tooltipTrackW > 0
        ? Math.min(PREVIEW_MAX_W, tooltipTrackW * PREVIEW_MAX_TRACK_FRAC)
        : PREVIEW_MAX_W
    const box = previewThumbBox(
      pv.videoWidth,
      pv.videoHeight,
      maxW,
      PREVIEW_MAX_H,
    )
    if (box.width !== thumbW || box.height !== thumbH) {
      thumbW = box.width
      thumbH = box.height
      const dpr = Math.min(PREVIEW_MAX_DPR, window.devicePixelRatio || 1)
      seekTooltipThumb.width = Math.round(box.width * dpr)
      seekTooltipThumb.height = Math.round(box.height * dpr)
      seekTooltipThumb.style.width = `${box.width}px`
      seekTooltipThumb.style.height = `${box.height}px`
      tooltipWidth = 0
    }
    // Resizing a canvas clears it but keeps the context, so this is fetched
    // once per track and survives an aspect change mid-playlist.
    if (!previewCtx) previewCtx = seekTooltipThumb.getContext('2d')
    if (!previewCtx) return
    previewCtx.drawImage(
      pv,
      0,
      0,
      seekTooltipThumb.width,
      seekTooltipThumb.height,
    )
    // Only open the card once there is a real frame in it: `seeked` can land
    // on metadata alone, and drawImage from that state is a silent no-op that
    // would otherwise leave an empty grey box under the timecode for good.
    if (!thumbShown && pv.videoWidth > 0) {
      thumbShown = true
      seekTooltip.classList.add('has-thumb')
      tooltipWidth = 0
    }
    if (tooltipVisible) positionSeekTooltip()
  }

  /** Ask for the frame under the pointer, at the granularity of one track pixel. */
  function requestPreviewFrame() {
    cancelPreviewTeardown() // the pointer is back on the bar
    const pv = ensurePreviewVideo()
    // HAVE_NOTHING: `currentTime` here only sets a start position and reports
    // no `seeked`, so the ask is deferred to `loadedmetadata` instead.
    if (!pv || pv.readyState < 1) return
    const step = requestPreviewSeek(previewSeek, lastHoverSecs, lastMinDelta)
    previewSeek = step.state
    drivePreviewSeek(step.seekTo)
  }

  cleanups.push(teardownPreview)

  /**
   * Re-clamp the bubble against the geometry of the last pointermove. Split out
   * because a frame landing changes the card's width long after the move that
   * asked for it, and a bubble that was flush with the end of the track has to
   * be pulled back in when it grows. `tooltipWidth === 0` means "stale, measure
   * again" — the one place offsetWidth is read, so the layout it forces is paid
   * only when the card has actually changed shape.
   */
  function positionSeekTooltip() {
    if (tooltipTrackW <= 0) return
    if (tooltipWidth === 0) tooltipWidth = seekTooltip.offsetWidth
    seekTooltip.style.left = `${clampTooltipCenter(tooltipCenterPx, tooltipWidth, tooltipTrackW)}px`
  }

  function updateSeekTooltip(clientX: number) {
    const dur = video.duration
    if (!Number.isFinite(dur) || dur <= 0) return hideSeekTooltip()
    const rect = progressWrap.getBoundingClientRect()
    if (rect.width <= 0) return
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const secs = pct * dur

    const label = formatSeekTime(secs, dur)
    if (label !== tooltipText) {
      seekTooltipTime.textContent = label
      tooltipText = label
      tooltipWidth = 0
    }
    tooltipCenterPx = pct * rect.width
    tooltipTrackW = rect.width
    positionSeekTooltip()

    // One track pixel of video: the smallest move that can put a different
    // frame in the bubble, and so the cheapest useful seek granularity.
    lastHoverSecs = secs
    lastMinDelta = dur / rect.width
    // Mid-drag the main video is already seeking to this very frame, in a
    // window far bigger than the bubble. A second decoder chasing it would only
    // fight it for the disk, so the last preview drawn just stays put.
    if (!scrubbing) requestPreviewFrame()

    if (!tooltipVisible) {
      tooltipVisible = true
      progressWrap.classList.add('seek-tooltip-visible')
    }
  }

  /** A finger gets no bubble; a mouse or a pen does. */
  function isHoverPointer(e: PointerEvent): boolean {
    return e.pointerType !== 'touch'
  }

  on(progressWrap, 'pointerenter', (e: PointerEvent) => {
    if (isHoverPointer(e)) updateSeekTooltip(e.clientX)
  })
  on(progressWrap, 'pointermove', (e: PointerEvent) => {
    if (isHoverPointer(e)) updateSeekTooltip(e.clientX)
  })
  on(progressWrap, 'pointerleave', () => {
    // A drag that has wandered off a 4px-tall bar is still a drag.
    if (!scrubbing) hideSeekTooltip()
  })
  on(document, 'pointermove', (e: PointerEvent) => {
    if (scrubbing && isHoverPointer(e)) updateSeekTooltip(e.clientX)
  })
  on(document, 'pointerup', (e: PointerEvent) => {
    // `scrubbing` is still true here — pointerup precedes the mouseup that
    // clears it — so ask the geometry instead of the flag.
    if (!tooltipVisible || !isHoverPointer(e)) return
    const r = progressWrap.getBoundingClientRect()
    const inside =
      e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom
    if (!inside) hideSeekTooltip()
  })

  // ── Fullscreen ──────────────────────────────────────────────────────────────
  function anchorOverlay() {
    bxWrap.style.bottom = ''
  }

  function isImmersive(): boolean {
    return isFullscreen() || isTheater
  }

  /**
   * `sticky` leaves the controls up with no auto-hide timer: theater keeps them
   * visible for as long as the pointer stays in the bottom strip, and hides them
   * the moment it leaves.
   */
  function showControls(sticky = false) {
    if (hideControlsTimer) clearTimeout(hideControlsTimer)
    // Theater re-runs this on every mousemove inside the bottom strip. Once the
    // bar is already up there is nothing to write, and the class churn was
    // dirtying style at trackpad event rates (100+/sec).
    if (!controlsVisible) {
      controlsVisible = true
      playerContainer.classList.add('controls-visible')
      controlsBar?.classList.add('controls-visible')
      anchorOverlay()
      // The bar carries the progress fill and the timecode, which the RAF loop
      // stops writing while it is down — so it needs one catch-up paint.
      scheduleFrame()
    }
    if (sticky) return
    hideControlsTimer = setTimeout(() => {
      if (isImmersive()) hideControls()
    }, 1000)
  }

  function hideControls() {
    // The fit popover hangs off the bar; taking the bar away mid-drag would
    // take the sliders with it. Every hide path funnels through here.
    if (isFitPopoverOpen()) return
    if (hideControlsTimer) clearTimeout(hideControlsTimer)
    if (!controlsVisible) return
    controlsVisible = false
    controlsBarH = 0
    playerContainer.classList.remove('controls-visible')
    controlsBar?.classList.remove('controls-visible')
    // The bar can go down under the pointer (a keyboard fullscreen toggle),
    // which leaves no pointerleave to hide the bubble with.
    hideSeekTooltip()
    anchorOverlay()
  }

  /** Show the pointer while it is moving, then let theater swallow it again. */
  function wakeCursor() {
    document.body.classList.add('pointer-active')
    if (cursorTimer) clearTimeout(cursorTimer)
    cursorTimer = setTimeout(() => {
      document.body.classList.remove('pointer-active')
    }, 1500)
  }

  /**
   * How close to the bottom edge the pointer has to be for theater to keep the
   * controls up. Hysteresis: raising them takes a thin band at the very bottom
   * of the screen, but once the bar is up it owns its own height — otherwise
   * moving onto the bar it just revealed would dismiss it.
   */
  function theaterControlsZone(): number {
    if (!controlsVisible) return THEATER_EDGE_ZONE
    // Measured once per raise, not per mousemove: `getBoundingClientRect` forces
    // layout, and this used to run on every pointer event with the bar up.
    if (controlsBarH === 0 && controlsBar) {
      controlsBarH = Math.round(controlsBar.getBoundingClientRect().height)
    }
    return Math.max(THEATER_EDGE_ZONE, controlsBarH)
  }

  function onEnterFullscreen() {
    playerContainer.classList.add('fullscreen-active')
    // Double-rAF: first frame browser applies fullscreen UA styles;
    // second frame layout is stable and getBoundingClientRect is reliable.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        resizeCanvas()
        showControls()
      }),
    )
  }

  function onExitFullscreen() {
    playerContainer.classList.remove('fullscreen-active', 'controls-visible')
    controlsBar?.classList.remove('controls-visible')
    controlsVisible = false
    if (hideControlsTimer) clearTimeout(hideControlsTimer)
    bxWrap.style.bottom = ''
    resizeCanvas()
  }

  function toggleFullscreen() {
    const container = byId<FsElement>('playerContainer')
    if (!isFullscreen()) {
      const req = container.requestFullscreen || container.webkitRequestFullscreen
      if (req) req.call(container).catch(() => {})
    } else {
      const d = document as FsDocument
      const exit = d.exitFullscreen || d.webkitExitFullscreen
      if (exit) exit.call(document)
    }
  }

  on(btnFullscreen, 'click', toggleFullscreen)

  on(document, 'fullscreenchange', () => {
    document.fullscreenElement ? onEnterFullscreen() : onExitFullscreen()
  })
  on(document, 'webkitfullscreenchange', () => {
    ;(document as FsDocument).webkitFullscreenElement
      ? onEnterFullscreen()
      : onExitFullscreen()
  })

  // ── Theater mode ─────────────────────────────────────────────────────────────

  function enterTheater() {
    isTheater = true
    document.body.classList.remove('theater-mode') // reset to replay animation
    void document.body.offsetWidth // force reflow
    document.body.classList.add('theater-mode')
    if (btnTheater) btnTheater.classList.add('active')
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        resizeCanvas()
        applyTheaterFit()
        showControls()
      }),
    )
  }

  function exitTheater() {
    isTheater = false
    if (cursorTimer) clearTimeout(cursorTimer)
    setFitPopover(false) // before hideControls, which refuses to run under it
    setPlaylistDrawer(false)
    document.body.classList.remove('theater-mode', 'pointer-active')
    if (btnTheater) btnTheater.classList.remove('active')
    hideControls()
    applyTheaterFit() // `isTheater` is already false: clears the stretch
    requestAnimationFrame(() => requestAnimationFrame(() => resizeCanvas()))
  }

  if (btnTheater) {
    on(btnTheater, 'click', () => {
      isTheater ? exitTheater() : enterTheater()
    })
  }

  // ── Theater fit popover ─────────────────────────────────────────────────────
  // The caps are tuned by watching footage, so the control lives on the picture
  // rather than on the settings page. The stored values are the starting point;
  // dragging here overrides them for the session and is never written back —
  // "what looks right for this video" and "what should every video start at"
  // are different questions, and only the settings page answers the second.

  function setFitPopover(open: boolean) {
    if (!fitPopover || !btnTheaterFit) return
    fitPopover.hidden = !open
    btnTheaterFit.classList.toggle('active', open)
    btnTheaterFit.setAttribute('aria-expanded', String(open))
    // Reaching for a slider means moving the pointer off the bottom edge, which
    // is the gesture that normally dismisses the bar. Pin it while open.
    if (open) showControls(true)
  }

  function isFitPopoverOpen(): boolean {
    return !!fitPopover && !fitPopover.hidden
  }

  /** Push the current caps into the sliders and their readouts. */
  function syncFitControls() {
    if (fitStretchSlider) fitStretchSlider.value = String(fitLimits.maxStretch)
    if (fitZoomSlider) fitZoomSlider.value = String(fitLimits.maxZoom)
    if (fitStretchValue)
      fitStretchValue.textContent = `${fitLimits.maxStretch.toFixed(2)}×`
    if (fitZoomValue) fitZoomValue.textContent = `${fitLimits.maxZoom.toFixed(2)}×`
  }

  /**
   * What the caps actually bought on this video. A cap is a ceiling, not a
   * setting: on a video whose gap is already closed, dragging stretch to 1.6
   * changes nothing on screen, and without this the control looks broken.
   */
  function reportFit(fit: TheaterFit) {
    if (!fitHint) return
    if (fit.scaleX === 1 && fit.scaleY === 1) {
      fitHint.textContent = 'no bars to close'
      return
    }
    const stretch = fit.scaleX / fit.scaleY
    fitHint.textContent = `${stretch.toFixed(2)}× wide · ${fit.scaleY.toFixed(2)}× zoom`
  }

  if (btnTheaterFit) {
    on(btnTheaterFit, 'click', (e: MouseEvent) => {
      e.stopPropagation()
      setFitPopover(!isFitPopoverOpen())
    })
  }
  if (fitPopover) {
    // The popover overlaps the picture, where a click is play/pause and a
    // pointer move re-arms the auto-hide. Neither should reach past it.
    on(fitPopover, 'click', (e: MouseEvent) => e.stopPropagation())
    on(fitPopover, 'mousemove', (e: MouseEvent) => e.stopPropagation())
  }
  if (fitStretchSlider) {
    on(fitStretchSlider, 'input', () => {
      fitLimits.maxStretch = clampStretch(parseFloat(fitStretchSlider.value))
      syncFitControls()
      applyTheaterFit()
    })
  }
  if (fitZoomSlider) {
    on(fitZoomSlider, 'input', () => {
      fitLimits.maxZoom = clampZoom(parseFloat(fitZoomSlider.value))
      syncFitControls()
      applyTheaterFit()
    })
  }
  if (btnFitReset) {
    on(btnFitReset, 'click', () => {
      fitLimits.maxStretch = storedLimits.maxStretch
      fitLimits.maxZoom = storedLimits.maxZoom
      syncFitControls()
      applyTheaterFit()
    })
  }
  // Anywhere else dismisses it, the same way the pointer leaving the bar does.
  on(document, 'click', () => {
    if (isFitPopoverOpen()) setFitPopover(false)
  })
  syncFitControls()

  // ── Theater playlist drawer ─────────────────────────────────────────────────
  // The sidebar is laid out by the page; theater only decides whether it is on
  // screen. Always starts closed — theater exists to get the chrome out of the
  // way — and `enterTheater` never opens it, so re-entering resets it.

  function isDrawerOpen(): boolean {
    return document.body.classList.contains('theater-sidebar-open')
  }

  function setPlaylistDrawer(open: boolean) {
    document.body.classList.toggle('theater-sidebar-open', open)
    if (btnPlaylistDrawer) btnPlaylistDrawer.classList.toggle('active', open)
  }

  if (btnPlaylistDrawer) {
    on(btnPlaylistDrawer, 'click', () => setPlaylistDrawer(!isDrawerOpen()))
  }
  if (btnCloseDrawer) {
    on(btnCloseDrawer, 'click', () => setPlaylistDrawer(false))
  }

  on(document, 'keydown', (e: KeyboardEvent) => {
    if (isTypingTarget(e)) return
    const key = e.key.toLowerCase()
    if (key === 't' && !e.shiftKey) {
      isTheater ? exitTheater() : enterTheater()
    }
    // Unshifted only: Shift+P is the previous track.
    if (key === 'p' && !e.shiftKey && isTheater && btnPlaylistDrawer) {
      setPlaylistDrawer(!isDrawerOpen())
    }
    // Shifted, because plain F is fullscreen — the far more common request, and
    // the key every other player in the world already uses for it.
    if (key === 'f' && e.shiftKey && isTheater && btnTheaterFit) {
      setFitPopover(!isFitPopoverOpen())
    }
    if (e.key === 'Escape' && isTheater) {
      // Escape unwinds one layer at a time, innermost first, and only means
      // "leave theater" once nothing is left on top of the picture.
      if (isFitPopoverOpen()) setFitPopover(false)
      else if (isDrawerOpen()) setPlaylistDrawer(false)
      else exitTheater()
    }
  })

  on(document, 'mousemove', (e: MouseEvent) => {
    if (isFullscreen()) {
      showControls()
      return
    }
    if (!isTheater) return
    // The controls stay down, but the pointer itself still has to come back or
    // there is no feedback at all for moving the mouse.
    wakeCursor()
    // Theater treats the control bar as a bottom-edge affordance rather than a
    // hover-anywhere one: moving over the picture leaves it alone.
    if (window.innerHeight - e.clientY <= theaterControlsZone()) showControls(true)
    else hideControls()
  })
  on(
    document,
    'touchstart',
    () => {
      // No pointer to put in the bottom strip on touch, so a tap anywhere does
      // it — and then the ordinary auto-hide takes over.
      if (isFullscreen() || isTheater) showControls()
    },
    { passive: true },
  )

  // ── ResizeObserver + start loop ─────────────────────────────────────────────
  // The strip drives the canvas; the wrap's box drives the theater fit. Between
  // them they catch the second-order changes — the strip growing takes height
  // off the picture, the drawer opening takes width — without either having to
  // know about the other.
  //
  // The wrap and NOT the video: `applyTheaterFit` sets the video's own
  // width/height, so observing the video would feed its output straight back in
  // as an input. Nothing here resizes the wrap.
  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      // A taller strip is height off the picture, so the strip's own resize has
      // to refit as well — the wrap is pinned to the viewport in theater and
      // will not fire for it.
      if (entry.target === bxWrap) resizeCanvas()
      applyTheaterFit()
    }
  })
  resizeObserver.observe(bxWrap)
  if (video.parentElement) resizeObserver.observe(video.parentElement)
  resizeCanvas()
  scheduleFrame()

  // Theater is the default way to watch; the setting is the opt-out.
  if (opts.autoTheater && userSettings.defaultTheater !== false) enterTheater()

  // ── Public API ──────────────────────────────────────────────────────────────
  return {
    loadBxData(path, frames, effects = [], peaks = []) {
      activePath = path
      totalFrames = frames
      activeEffects = Array.isArray(effects) ? effects : []

      // If peaks were explicitly provided, use them. Otherwise auto-derive from
      // the path by finding local extrema (bounce points where direction reverses).
      if (Array.isArray(peaks) && peaks.length > 0) {
        activePeaks = peaks
      } else if (path && path.length > 0) {
        const derived: number[] = []
        let prevDir = 0
        for (let f = 1; f < path.length - 1; f++) {
          if (path[f] < 0 || path[f - 1] < 0) {
            prevDir = 0
            continue
          }
          const dir = Math.sign(path[f] - path[f - 1])
          if (dir !== 0 && prevDir !== 0 && dir !== prevDir) derived.push(f)
          if (dir !== 0) prevDir = dir
        }
        activePeaks = derived
      } else {
        activePeaks = []
      }
      // `totalFrames` is the duration half of the timecode string.
      lastTimecodeSecs = -1
      scheduleFrame()
    },
    resetSmoothTime() {
      smoothTime = 0
      lastRafTime = null
      // A new track changes the duration half of the timecode, so the
      // same-second skip must not suppress the first write.
      lastTimecodeSecs = -1
      scheduleFrame()
    },
    // Callers reach for this after swapping a track in; the picture has to be
    // refitted to the new one, not just the canvas.
    resizeCanvas() {
      resizeCanvas()
      applyTheaterFit()
    },
    setOffset(secs) {
      offsetSecs = typeof secs === 'number' && secs > 0 ? secs : 0
      scheduleFrame()
    },
    destroy() {
      destroyed = true
      cancelAnimationFrame(rafId)
      if (frameCallbackId) frameVideo.cancelVideoFrameCallback?.(frameCallbackId)
      resizeObserver.disconnect()
      if (seekingLongTimer) clearTimeout(seekingLongTimer)
      if (hideControlsTimer) clearTimeout(hideControlsTimer)
      if (cursorTimer) clearTimeout(cursorTimer)
      for (const fn of cleanups) fn()
      cleanups.length = 0
      document.body.classList.remove(
        'theater-mode',
        'pointer-active',
        'theater-sidebar-open',
      )
      video.style.transform = '' // the element outlives the engine on re-init
    },
  }
}
