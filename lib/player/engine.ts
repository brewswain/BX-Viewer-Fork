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
  EDGE_PAD,
  FPS,
  PX_PER_FRAME,
  THEATER_EDGE_ZONE,
} from './constants'
import {
  buildColors,
  framesToTimecode,
  getEffectFadeAlpha,
  getEffectiveColorRgb,
  hexToRgbArr,
} from './format'
import {
  clampStretch,
  clampZoom,
  fitTransform,
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
  const progressFill = byId<HTMLElement>('progressFill')
  const progressThumb = byId<HTMLElement>('progressThumb')
  const timeDisplay = byId<HTMLElement>('timeDisplay')
  const btnPlay = byId<HTMLButtonElement>('btnPlay')
  const playIcon = byId<HTMLElement>('playIcon')
  const btnRewind = byId<HTMLButtonElement>('btnRewind')
  const btnForward = byId<HTMLButtonElement>('btnForward')
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
  const zoomSliderEl = byId<HTMLInputElement>('zoomSlider')
  const speedSliderEl = byId<HTMLInputElement>('speedSlider')
  const flipYBtn = byId<HTMLButtonElement>('flipYBtn') // null in playlist
  const pathBtn = byId<HTMLButtonElement>('pathBtn')
  // Theater playlist drawer — both null outside the playlist page.
  const btnPlaylistDrawer = byId<HTMLButtonElement>('btnPlaylistDrawer')
  const btnCloseDrawer = byId<HTMLButtonElement>('btnTheaterSidebarClose')
  const tapIndicator = byId<HTMLElement>('videoTapIndicator')
  const tapIndicatorIcon = byId<HTMLElement>('videoTapIndicatorIcon') // <svg>

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
  let flipY = userSettings.defaultFlipY === true
  // Purely a display switch — for videos that already have the path burned in.
  // The .bx stays loaded and `onFrame` keeps reporting, so device output and
  // the OSSM export are unaffected by it.
  let pathHidden = false
  let isSeeking = false
  let wasPlayingBeforeSeek = false
  let seekingLongTimer: ReturnType<typeof setTimeout> | null = null
  let scrubbing = false
  let hideControlsTimer: ReturnType<typeof setTimeout> | null = null
  let cursorTimer: ReturnType<typeof setTimeout> | null = null
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
  overlayBgBtn.style.display = isOverlay ? '' : 'none'
  overlayBgBtn.textContent = `bg: ${overlayBg ? 'on' : 'off'}`
  overlayBgBtn.classList.toggle('active', overlayBg)
  if (flipYBtn) {
    flipYBtn.textContent = `flip Y: ${flipY ? 'on' : 'off'}`
    flipYBtn.classList.toggle('active', flipY)
  }
  applyPathHidden()

  // ── Volume: restore persisted state ────────────────────────────────────────
  const savedVolume = sessionStorage.getItem('playerVolume')
  const savedMuted = sessionStorage.getItem('playerMuted')
  if (savedVolume !== null) {
    video.volume = parseFloat(savedVolume)
    volumeSlider.value = savedVolume
  }
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
   * Transform only — the layout box, the strip and the canvas are untouched, so
   * this can run as often as it likes. Outside theater the style is cleared and
   * `object-fit: contain` is back in sole charge.
   *
   * `clientWidth/Height` rather than `getBoundingClientRect`, which would report
   * the box we just scaled and wind the stretch up on every call.
   */
  function applyTheaterFit() {
    if (!isTheater) {
      video.style.transform = ''
      return
    }
    const fit = theaterFit(
      video.clientWidth,
      video.clientHeight,
      video.videoWidth,
      video.videoHeight,
      fitLimits,
    )
    video.style.transform = fitTransform(fit)
    reportFit(fit)
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
    const viewerXCache = new Map<number, number>()
    viewerXCache.set(curFrameExact, ballX)

    let xAccR = ballX
    const vMaxF = Math.min(totalFrames - 1, Math.ceil(curFrameExact) + visRange)
    for (let f = Math.ceil(curFrameExact); f <= vMaxF; f++) {
      xAccR += basePixPerFrame * viewerSpeedAt(f - 0.5)
      viewerXCache.set(f, xAccR)
    }
    let xAccL = ballX
    const vMinF = Math.max(0, Math.floor(curFrameExact) - visRange)
    for (let f = Math.floor(curFrameExact); f >= vMinF; f--) {
      if (!viewerXCache.has(f)) {
        xAccL -= basePixPerFrame * viewerSpeedAt(f + 0.5)
        viewerXCache.set(f, xAccL)
      }
    }
    function viewerFrameToX(f: number): number {
      if (viewerXCache.has(f)) return viewerXCache.get(f) as number
      const fl = Math.floor(f),
        fr = Math.ceil(f)
      const xl =
        viewerXCache.get(fl) ?? ballX + (fl - curFrameExact) * basePixPerFrame
      const xr =
        viewerXCache.get(fr) ?? ballX + (fr - curFrameExact) * basePixPerFrame
      return xl + (xr - xl) * (f - fl)
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
    } else if (overlayBg) {
      const [bgR, bgG, bgB] =
        bgRgb || hexToRgbArr(userSettings.bgColor || '#0a0b0f')
      ctx.fillStyle = `rgba(${bgR},${bgG},${bgB},0.45)`
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
          const delta = (rafTime - lastRafTime) / 1000
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

    const t = isSeeking ? smoothTime : video.currentTime || 0
    const dur = video.duration || totalFrames / FPS
    const pct = dur > 0 ? (t / dur) * 100 : 0
    progressFill.style.width = `${pct}%`
    progressThumb.style.left = `${pct}%`
    timeDisplay.textContent = `${framesToTimecode(Math.floor(t * FPS))} / ${framesToTimecode(totalFrames)}`

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

  on(overlayBtn, 'click', () => {
    isOverlay = !isOverlay
    overlayBtn.textContent = `overlay: ${isOverlay ? 'on' : 'off'}`
    overlayBtn.classList.toggle('active', isOverlay)
    bxWrap.classList.toggle('overlay-mode', isOverlay)
    overlayBgBtn.style.display = isOverlay ? '' : 'none'
    resizeCanvas()
    if (isFullscreen()) anchorOverlay()
  })

  on(overlayBgBtn, 'click', () => {
    overlayBg = !overlayBg
    overlayBgBtn.textContent = `bg: ${overlayBg ? 'on' : 'off'}`
    overlayBgBtn.classList.toggle('active', overlayBg)
    scheduleFrame()
  })

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

  on(video, 'play', () => {
    playIcon.innerHTML = PAUSE_GLYPH
    playIcon.setAttribute('fill', 'currentColor')
  })
  on(video, 'pause', () => {
    playIcon.innerHTML = PLAY_GLYPH
  })
  on(video, 'ended', () => {
    playIcon.innerHTML = PLAY_GLYPH
    if (onEnded) onEnded()
  })

  on(btnRewind, 'click', () => {
    video.currentTime = Math.max(0, video.currentTime - 5)
  })
  on(btnForward, 'click', () => {
    video.currentTime = Math.min(video.duration || 0, video.currentTime + 5)
  })

  on(document, 'keydown', (e: KeyboardEvent) => {
    if (isTypingTarget(e)) return
    if (e.code === 'Space') {
      e.preventDefault()
      togglePlay()
    }
    if (e.code === 'ArrowLeft')
      video.currentTime = Math.max(0, video.currentTime - 5)
    if (e.code === 'ArrowRight')
      video.currentTime = Math.min(video.duration || 0, video.currentTime + 5)
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
  on(volumeSlider, 'input', () => {
    video.volume = parseFloat(volumeSlider.value)
    video.muted = video.volume === 0
    sessionStorage.setItem('playerVolume', volumeSlider.value)
    sessionStorage.setItem('playerMuted', String(video.muted))
    updateVolIcon()
  })

  on(btnMute, 'click', () => {
    video.muted = !video.muted
    volumeSlider.value = String(video.muted ? 0 : video.volume)
    sessionStorage.setItem('playerMuted', String(video.muted))
    sessionStorage.setItem('playerVolume', String(video.volume))
    updateVolIcon()
  })

  function updateVolIcon() {
    if (video.muted || video.volume === 0) {
      volIcon.innerHTML = `<polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>`
    } else {
      volIcon.innerHTML = `<polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M15.54,8.46a5,5,0,0,1,0,7.07"/><path d="M19.07,4.93a10,10,0,0,1,0,14.14"/>`
    }
  }

  // ── Progress bar scrubbing ──────────────────────────────────────────────────
  function seekTo(clientX: number) {
    const rect = progressWrap.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    video.currentTime = pct * (video.duration || 0)
  }

  on(progressWrap, 'mousedown', (e: MouseEvent) => {
    scrubbing = true
    seekTo(e.clientX)
    scheduleFrame() // grabbing the thumb at the current position seeks nowhere
  })
  on(document, 'mousemove', (e: MouseEvent) => {
    if (scrubbing) seekTo(e.clientX)
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
      if (scrubbing && e.touches.length) seekTo(e.touches[0].clientX)
    },
    { passive: true },
  )
  on(document, 'touchend', () => {
    scrubbing = false
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
    const container = byId<HTMLElement>('playerContainer')
    const controls = container.querySelector('.player-controls')
    container.classList.add('controls-visible')
    if (controls) controls.classList.add('controls-visible')
    anchorOverlay()
    if (hideControlsTimer) clearTimeout(hideControlsTimer)
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
    const container = byId<HTMLElement>('playerContainer')
    const controls = container.querySelector('.player-controls')
    container.classList.remove('controls-visible')
    if (controls) controls.classList.remove('controls-visible')
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
    const container = byId<HTMLElement>('playerContainer')
    if (!container.classList.contains('controls-visible')) {
      return THEATER_EDGE_ZONE
    }
    const controls = container.querySelector('.player-controls')
    const barH = controls ? controls.getBoundingClientRect().height : 0
    return Math.max(THEATER_EDGE_ZONE, Math.round(barH))
  }

  function onEnterFullscreen() {
    const container = byId<HTMLElement>('playerContainer')
    container.classList.add('fullscreen-active')
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
    const container = byId<HTMLElement>('playerContainer')
    container.classList.remove('fullscreen-active', 'controls-visible')
    const controls = container.querySelector('.player-controls')
    if (controls) controls.classList.remove('controls-visible')
    if (hideControlsTimer) clearTimeout(hideControlsTimer)
    bxWrap.style.bottom = ''
    resizeCanvas()
  }

  on(btnFullscreen, 'click', () => {
    const container = byId<FsElement>('playerContainer')
    if (!isFullscreen()) {
      const req = container.requestFullscreen || container.webkitRequestFullscreen
      if (req) req.call(container).catch(() => {})
    } else {
      const d = document as FsDocument
      const exit = d.exitFullscreen || d.webkitExitFullscreen
      if (exit) exit.call(document)
    }
  })

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
    if (e.key === 't' || e.key === 'T') {
      isTheater ? exitTheater() : enterTheater()
    }
    if ((e.key === 'p' || e.key === 'P') && isTheater && btnPlaylistDrawer) {
      setPlaylistDrawer(!isDrawerOpen())
    }
    if ((e.key === 'f' || e.key === 'F') && isTheater && btnTheaterFit) {
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
  // The strip drives the canvas; the video's own box drives the theater fit.
  // Watching the video is what catches the second-order changes — the strip
  // growing takes height off the picture, and the drawer opening takes width —
  // without either having to know about the other.
  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      entry.target === video ? applyTheaterFit() : resizeCanvas()
    }
  })
  resizeObserver.observe(bxWrap)
  resizeObserver.observe(video)
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
      scheduleFrame()
    },
    resetSmoothTime() {
      smoothTime = 0
      lastRafTime = null
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
