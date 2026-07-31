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
  EDGE_PAD,
  FPS,
  PX_PER_FRAME,
} from './constants'
import {
  buildColors,
  framesToTimecode,
  getEffectFadeAlpha,
  getEffectiveColorRgb,
  hexToRgbArr,
} from './format'
import type { BxEffect } from './types'

export type PlayerEngineOptions = {
  video: HTMLVideoElement
  canvas: HTMLCanvasElement
  /** The `.bouncex-wrap` div. */
  bxWrap: HTMLElement
  userSettings: Partial<Settings>
  /** Seconds before the path starts (default 0). */
  offsetSecs?: number
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
  const progressWrap = byId<HTMLElement>('progressWrap')
  const zoomSliderEl = byId<HTMLInputElement>('zoomSlider')
  const speedSliderEl = byId<HTMLInputElement>('speedSlider')
  const flipYBtn = byId<HTMLButtonElement>('flipYBtn') // null in playlist
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
  let isSeeking = false
  let wasPlayingBeforeSeek = false
  let seekingLongTimer: ReturnType<typeof setTimeout> | null = null
  let scrubbing = false
  let hideControlsTimer: ReturnType<typeof setTimeout> | null = null
  let isTheater = false

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

  function getOverlayRefHeight(): number {
    return isFullscreen() || isTheater
      ? Math.round(window.innerHeight * 0.35)
      : BX_HEIGHT_OVERLAY
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
      h = Math.round(window.innerHeight * 0.35)
    } else {
      h = BX_HEIGHT_OVERLAY
    }
    canvas.width = w || bxWrap.offsetWidth || 800
    canvas.height = h
  }

  // ── Canvas rendering ────────────────────────────────────────────────────────
  function drawBounceX() {
    if (!activePath) return
    const path = activePath
    const W = canvas.width,
      H = canvas.height
    if (W === 0 || H === 0) return

    ctx.clearRect(0, 0, W, H)

    const curFrameExact = Math.min(
      (smoothTime - offsetSecs) * FPS,
      totalFrames - 1,
    )
    const curFrame = Math.floor(curFrameExact)
    const frac = curFrameExact - curFrame
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

    const depthA = curFrame >= 0 && path[curFrame] >= 0 ? path[curFrame] : 0
    const depthB =
      curFrame >= 0
        ? path[Math.min(curFrame + 1, totalFrames - 1)] >= 0
          ? path[Math.min(curFrame + 1, totalFrames - 1)]
          : depthA
        : 0
    const curDepth = depthA + (depthB - depthA) * (curFrame >= 0 ? frac : 0)
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
  function loop(rafTime: number) {
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
    rafId = requestAnimationFrame(loop)
  }

  // ── Overlay toggles ─────────────────────────────────────────────────────────
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
  })

  if (flipYBtn) {
    on(flipYBtn, 'click', () => {
      flipY = !flipY
      flipYBtn.textContent = `flip Y: ${flipY ? 'on' : 'off'}`
      flipYBtn.classList.toggle('active', flipY)
    })
  }

  on(zoomSliderEl, 'input', () => {
    if (!isOverlay) resizeCanvas()
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
    const target = e.target as HTMLElement | null
    if (target?.tagName === 'INPUT' || target?.tagName === 'SELECT') return
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

  function showControls() {
    const container = byId<HTMLElement>('playerContainer')
    const controls = container.querySelector('.player-controls')
    container.classList.add('controls-visible')
    if (controls) controls.classList.add('controls-visible')
    anchorOverlay()
    if (hideControlsTimer) clearTimeout(hideControlsTimer)
    hideControlsTimer = setTimeout(() => {
      if (isImmersive()) {
        container.classList.remove('controls-visible')
        if (controls) controls.classList.remove('controls-visible')
        anchorOverlay()
      }
    }, 1000)
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
        showControls()
      }),
    )
  }

  function exitTheater() {
    isTheater = false
    document.body.classList.remove('theater-mode')
    if (btnTheater) btnTheater.classList.remove('active')
    if (hideControlsTimer) clearTimeout(hideControlsTimer)
    const container = byId<HTMLElement>('playerContainer')
    const controls = container.querySelector('.player-controls')
    container.classList.remove('controls-visible')
    if (controls) controls.classList.remove('controls-visible')
    requestAnimationFrame(() => requestAnimationFrame(() => resizeCanvas()))
  }

  if (btnTheater) {
    on(btnTheater, 'click', () => {
      isTheater ? exitTheater() : enterTheater()
    })
  }

  on(document, 'keydown', (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null
    if (
      target?.tagName === 'INPUT' ||
      target?.tagName === 'TEXTAREA' ||
      target?.tagName === 'SELECT'
    )
      return
    if (e.key === 't' || e.key === 'T') {
      isTheater ? exitTheater() : enterTheater()
    }
    if (e.key === 'Escape' && isTheater) {
      exitTheater()
    }
  })

  on(document, 'mousemove', () => {
    if (isFullscreen()) showControls()
    else if (isTheater) showControls()
  })
  on(
    document,
    'touchstart',
    () => {
      if (isFullscreen()) showControls()
    },
    { passive: true },
  )

  // ── ResizeObserver + start loop ─────────────────────────────────────────────
  const resizeObserver = new ResizeObserver(() => resizeCanvas())
  resizeObserver.observe(bxWrap)
  resizeCanvas()
  rafId = requestAnimationFrame(loop)

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
    },
    resetSmoothTime() {
      smoothTime = 0
      lastRafTime = null
    },
    resizeCanvas,
    setOffset(secs) {
      offsetSecs = typeof secs === 'number' && secs > 0 ? secs : 0
    },
    destroy() {
      destroyed = true
      cancelAnimationFrame(rafId)
      resizeObserver.disconnect()
      if (seekingLongTimer) clearTimeout(seekingLongTimer)
      if (hideControlsTimer) clearTimeout(hideControlsTimer)
      for (const fn of cleanups) fn()
      cleanups.length = 0
      document.body.classList.remove('theater-mode')
    },
  }
}
