'use client'

/**
 * Single-video watch page.
 *
 * React owns the markup; the canvas engine (`@/lib/player/engine`) stays
 * imperative and is created once per loaded video from an effect. Per-frame
 * updates (sidebar depth/frame readouts, marker highlight) are still direct DOM
 * writes — routing them through state would re-render at 60fps.
 */

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'

import DevicePanel from '@/components/player/DevicePanel'
import PlayerControls from '@/components/player/PlayerControls'
import SiteHeader from '@/components/SiteHeader'
import VideoWrap from '@/components/player/VideoWrap'
import { deviceManager } from '@/lib/device/manager'
import {
  buildPath,
  findPeaks,
  loadEffectFonts,
  markersFromData,
  parseBx,
} from '@/lib/player/bx'
import { FPS, VIDEO_BASE } from '@/lib/player/constants'
import { createPlayerEngine, type PlayerEngine } from '@/lib/player/engine'
import {
  easeLabel,
  fetchJSON,
  fetchText,
  framesToTimecode,
  renderDescription,
} from '@/lib/player/format'
import type { BxSource, Marker, VideoMeta } from '@/lib/player/types'
import { deviceConfigFromSettings, getSettings } from '@/lib/settings'

type Loaded = {
  id: string
  meta: VideoMeta
  bxSources: BxSource[]
  path: Float32Array
  initialFrames: number
}

type SuggestionMeta = VideoMeta & { _folder: string; videoId?: string }

type Suggestions =
  | { state: 'loading' }
  | { state: 'empty' }
  | { state: 'failed' }
  | { state: 'ok'; items: SuggestionMeta[] }

function LoadingLayout({ text }: { text: string }) {
  return (
    <div className="player-layout" id="playerLayout">
      <div className="loading-msg" id="loadingMsg">
        {text}
      </div>
    </div>
  )
}

function WatchInner() {
  const searchParams = useSearchParams()
  const videoId = searchParams.get('v')

  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [activeBxIndex, setActiveBxIndex] = useState(0)
  const [sidebarTab, setSidebarTab] = useState<'bx' | 'more'>('more')
  const [stats, setStats] = useState<{ duration: string; frames: string }>({
    duration: '–',
    frames: '–',
  })
  const [suggestions, setSuggestions] = useState<Suggestions>({ state: 'loading' })

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const bxWrapRef = useRef<HTMLDivElement | null>(null)

  const engineRef = useRef<PlayerEngine | null>(null)
  const totalFramesRef = useRef(0)
  const activeMarkersRef = useRef<Marker[]>([])
  const lastHighlightedRef = useRef(-1)
  const bxIndexRef = useRef(0)
  const bxInitRef = useRef<Loaded | null>(null)

  // ── Service Worker ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
  }, [])

  // ── Load meta + bx sources ──────────────────────────────────────────────────
  useEffect(() => {
    if (!videoId) return
    let cancelled = false

    setLoaded(null)
    setErrorMsg(null)
    setActiveBxIndex(0)
    bxIndexRef.current = 0
    setStats({ duration: '–', frames: '–' })
    setSuggestions({ state: 'loading' })

    async function loadPlayer(id: string) {
      try {
        // meta.json is optional — fall back to folder-name defaults if absent
        let meta: VideoMeta
        try {
          meta = await fetchJSON<VideoMeta>(
            `${VIDEO_BASE}/${encodeURIComponent(id)}/meta.json`,
          )
        } catch (e) {
          if (/HTTP 404/.test((e as Error).message)) {
            meta = {
              title: id,
              videoFile: `${id}.mp4`,
              bxFiles: [{ label: 'Default', file: `${id}.bx` }],
            }
          } else {
            throw e
          }
        }

        // Normalise missing videoFile — assume <folder>.mp4 by convention
        if (!meta.videoFile) meta.videoFile = `${id}.mp4`

        // Normalise legacy single-file field so all downstream code only sees bxFiles
        if (!meta.bxFiles && meta.bxFile) {
          meta.bxFiles = [{ label: 'Default', file: meta.bxFile }]
        }
        if (!meta.bxFiles || meta.bxFiles.length === 0) {
          throw new Error('No bx path file specified in meta.json')
        }

        const bxSources: BxSource[] = await Promise.all(
          meta.bxFiles.map(async (b) => {
            const url = `${VIDEO_BASE}/${encodeURIComponent(id)}/${encodeURIComponent(b.file)}`
            const raw = await fetchText(url)
            try {
              // Support plain .bx, version:2 at root, and new meta.version structure
              const { markerData, effects } = parseBx(JSON.parse(raw))
              const markers = markersFromData(markerData)
              return {
                label: b.label || 'Default',
                file: b.file,
                data: markerData,
                effects,
                peaks: findPeaks(markers),
              }
            } catch (e) {
              throw new Error(
                `Could not load bx file "${b.file}": ${(e as Error).message}`,
              )
            }
          }),
        )

        document.title = `${meta.title || id} – BounceX Viewer`

        // Load any custom fonts referenced by text effects
        const allEffects = bxSources.flatMap((s) => s.effects || [])
        await loadEffectFonts(allEffects, id)

        // Derive initial frame count from bx data — real value set via loadedmetadata
        const markerData = bxSources[0].data
        const maxBxFrame =
          Object.keys(markerData).reduce((m, k) => Math.max(m, parseInt(k)), 0) + 1
        const initialFrames = Math.max(maxBxFrame, 1)

        const path = buildPath(markerData, initialFrames)

        if (cancelled) return
        setLoaded({ id, meta, bxSources, path, initialFrames })
      } catch (e) {
        if (cancelled) return
        setErrorMsg((e as Error).message)
        console.error(e)
      }
    }

    loadPlayer(videoId)
    return () => {
      cancelled = true
    }
  }, [videoId])

  // Markers for the currently selected .bx source.
  const activeMarkers = useMemo<Marker[]>(
    () => (loaded ? markersFromData(loaded.bxSources[activeBxIndex].data) : []),
    [loaded, activeBxIndex],
  )
  activeMarkersRef.current = activeMarkers

  // ── Device output ───────────────────────────────────────────────────────────
  // Settings are read on load, the same way the engine consumes them. The
  // manager owns the socket and outlives this page, so all that happens here is
  // handing over the plan for the selected .bx and refreshing the mapping.
  useEffect(() => {
    const config = deviceConfigFromSettings(getSettings())
    deviceManager.configure(config)
    if (activeMarkers.length >= 2) deviceManager.setMarkers(activeMarkers)
    else deviceManager.clearMarkers()
    if (config.enabled && config.autoConnect && !deviceManager.isConnected()) {
      void deviceManager.connect()
    }
  }, [activeMarkers])

  // Navigating away must stop the machine, even though the socket stays up.
  useEffect(() => () => deviceManager.clearMarkers(), [])

  // The device panel lives in the BX tab, which is not the default one. Open it
  // for people who have output switched on, so the connect button is reachable
  // without having to know where it lives. Deliberately an effect rather than a
  // seeded initial state: localStorage is client-only and would desync
  // hydration.
  useEffect(() => {
    if (loaded && getSettings().deviceEnabled) setSidebarTab('bx')
  }, [loaded])

  // ── Engine + single-video overlays ──────────────────────────────────────────
  useEffect(() => {
    if (!loaded) return
    const video = videoRef.current
    const canvas = canvasRef.current
    const bxWrap = bxWrapRef.current
    if (!video || !canvas || !bxWrap) return

    const { meta, bxSources, path, initialFrames } = loaded

    // Single-video–only DOM refs
    const videoLoadingOverlay = document.getElementById('videoLoadingOverlay')
    const videoLoadingProgressText = document.getElementById(
      'videoLoadingProgressText',
    )
    const videoLoadingProgressFill = document.getElementById(
      'videoLoadingProgressFill',
    )
    const videoBufferingOverlay = document.getElementById('videoBufferingOverlay')
    const videoSeekingOverlay = document.getElementById('videoSeekingOverlay')
    const videoSeekingOverlayText = document.getElementById(
      'videoSeekingOverlayText',
    )
    const videoSeekingOverlayHint = document.getElementById(
      'videoSeekingOverlayHint',
    )
    const curDepthEl = document.getElementById('curDepth')
    const curFrameEl = document.getElementById('curFrame')
    const markerListEl = document.getElementById('markerList')

    const userSettings = getSettings()
    let hasCanPlayed = false
    let seekingLongTimer: ReturnType<typeof setTimeout> | null = null

    lastHighlightedRef.current = -1
    totalFramesRef.current = initialFrames

    // ── Seeking overlays ──────────────────────────────────────────────────────
    function onSeeking() {
      if (videoSeekingOverlay) videoSeekingOverlay.removeAttribute('aria-hidden')
      if (videoSeekingOverlayText)
        videoSeekingOverlayText.textContent = 'Seeking…'
      if (videoSeekingOverlayHint)
        videoSeekingOverlayHint.setAttribute('aria-hidden', 'true')
      if (seekingLongTimer) clearTimeout(seekingLongTimer)
      seekingLongTimer = setTimeout(() => {
        seekingLongTimer = null
        if (videoSeekingOverlayText)
          videoSeekingOverlayText.textContent = 'Re-buffering…'
        if (videoSeekingOverlayHint)
          videoSeekingOverlayHint.removeAttribute('aria-hidden')
      }, 2500)
    }

    function onSeeked() {
      if (seekingLongTimer) clearTimeout(seekingLongTimer)
      seekingLongTimer = null
      if (videoSeekingOverlay)
        videoSeekingOverlay.setAttribute('aria-hidden', 'true')
      if (videoSeekingOverlayHint)
        videoSeekingOverlayHint.setAttribute('aria-hidden', 'true')
    }

    function onCanPlay() {
      hasCanPlayed = true
      if (videoLoadingOverlay)
        videoLoadingOverlay.setAttribute('aria-hidden', 'true')
      if (videoBufferingOverlay)
        videoBufferingOverlay.setAttribute('aria-hidden', 'true')
    }

    function onWaiting() {
      if (!hasCanPlayed) return
      if (videoBufferingOverlay)
        videoBufferingOverlay.removeAttribute('aria-hidden')
    }

    function onPlaying() {
      if (videoBufferingOverlay)
        videoBufferingOverlay.setAttribute('aria-hidden', 'true')
    }

    function formatTime(secs: number) {
      return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(Math.floor(secs % 60)).padStart(2, '0')}`
    }

    function onProgress() {
      if (
        !videoLoadingOverlay ||
        videoLoadingOverlay.getAttribute('aria-hidden') === 'true'
      )
        return
      const b = video!.buffered
      const bufferedEnd = b.length ? b.end(b.length - 1) : 0
      const dur = video!.duration
      if (Number.isFinite(dur) && dur > 0) {
        const pct = Math.min(100, (bufferedEnd / dur) * 100)
        if (videoLoadingProgressFill)
          videoLoadingProgressFill.style.width = `${pct}%`
        if (videoLoadingProgressText)
          videoLoadingProgressText.textContent =
            pct >= 100
              ? 'Almost ready…'
              : `Buffered ${formatTime(bufferedEnd)} / ${formatTime(dur)} (${Math.round(pct)}%)`
      } else {
        if (videoLoadingProgressText)
          videoLoadingProgressText.textContent =
            bufferedEnd > 0
              ? `Loading metadata… (${formatTime(bufferedEnd)} received)`
              : 'Loading metadata…'
        if (videoLoadingProgressFill) videoLoadingProgressFill.style.width = '0%'
      }
    }

    // If video is already ready (e.g. cached), hide loading overlay immediately
    if (video.readyState >= 3) {
      hasCanPlayed = true
      if (videoLoadingOverlay)
        videoLoadingOverlay.setAttribute('aria-hidden', 'true')
    } else {
      onProgress()
    }

    // ── Per-frame callback: update sidebar stats + marker highlight ───────────
    function onFrame(curFrame: number, curDepth: number) {
      // Device first, and unconditionally: `curFrame` is the engine's smoothed
      // position with the video's own path offset already applied, which makes
      // it a better clock than `video.currentTime`. The driver is O(1) when
      // nothing is due, so this is safe on a callback that runs every rAF.
      // Pausing stops the machine on the one frame the engine schedules for the
      // `pause` event before its loop goes idle. `paused` covers scrubbing too:
      // the engine pauses the video for the duration of a seek.
      deviceManager.tick(
        (curFrame / FPS) * 1000,
        !video!.paused && !video!.ended && video!.readyState >= 2,
      )

      if (curFrameEl) curFrameEl.textContent = String(curFrame)
      if (curDepthEl) curDepthEl.textContent = curDepth.toFixed(3)

      let nearestIdx = -1,
        nearestDist = Infinity
      activeMarkersRef.current.forEach((m, i) => {
        const dist = Math.abs(m.frame - curFrame)
        if (dist < nearestDist) {
          nearestDist = dist
          nearestIdx = i
        }
      })
      if (nearestIdx !== lastHighlightedRef.current) {
        const prev = markerListEl?.querySelector('.marker-list-item.current')
        if (prev) prev.classList.remove('current')
        const next = document.getElementById(`mli-${nearestIdx}`)
        if (next) next.classList.add('current')
        lastHighlightedRef.current = nearestIdx
      }
    }

    // ── Create shared engine ──────────────────────────────────────────────────
    const engine = createPlayerEngine({
      video,
      canvas,
      bxWrap,
      userSettings,
      offsetSecs: typeof meta.offset === 'number' ? meta.offset / 1000 : 0,
      autoTheater: true,
      onSeeking,
      onSeeked,
      onCanPlay,
      onWaiting,
      onPlaying,
      onProgress,
      onFrame,
    })
    engineRef.current = engine

    engine.loadBxData(
      path,
      initialFrames,
      bxSources[0].effects || [],
      bxSources[0].peaks || [],
    )

    // ── Auto-detect real duration from the video element ─────────────────────
    function onVideoMetadataLoaded() {
      if (!Number.isFinite(video!.duration) || video!.duration <= 0) return
      const realFrames = Math.round(video!.duration * FPS)
      totalFramesRef.current = realFrames

      bxSources.forEach((src) => {
        src.path = buildPath(src.data, realFrames)
      })

      const activeIdx = bxIndexRef.current
      engine.loadBxData(
        bxSources[activeIdx].path || path,
        realFrames,
        bxSources[activeIdx].effects || [],
        bxSources[activeIdx].peaks || [],
      )

      setStats({
        duration: framesToTimecode(realFrames),
        frames: realFrames.toLocaleString(),
      })
    }

    video.addEventListener('loadedmetadata', onVideoMetadataLoaded)
    if (Number.isFinite(video.duration) && video.duration > 0)
      onVideoMetadataLoaded()

    return () => {
      video.removeEventListener('loadedmetadata', onVideoMetadataLoaded)
      if (seekingLongTimer) clearTimeout(seekingLongTimer)
      engine.destroy()
      engineRef.current = null
    }
  }, [loaded])

  // ── BX file dropdown ────────────────────────────────────────────────────────
  useEffect(() => {
    bxIndexRef.current = activeBxIndex
    const engine = engineRef.current
    if (!engine || !loaded) return
    // First pass for a freshly loaded video: the engine effect above already
    // pushed source 0, so don't re-push it (and don't clobber a frame count
    // that `loadedmetadata` may have already corrected).
    if (bxInitRef.current !== loaded) {
      bxInitRef.current = loaded
      return
    }
    const src = loaded.bxSources[activeBxIndex]
    const frames = totalFramesRef.current
    const newPath = src.path || buildPath(src.data, frames)
    engine.loadBxData(newPath, frames, src.effects || [], src.peaks || [])
    lastHighlightedRef.current = -1
  }, [activeBxIndex, loaded])

  // ── Marker click-to-seek ────────────────────────────────────────────────────
  function seekToFrame(frame: number) {
    const video = videoRef.current
    if (video) video.currentTime = frame / FPS
  }

  // ── More Videos ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!loaded) return
    let cancelled = false
    const currentId = loaded.id
    const currentTags = loaded.meta.tags || []

    async function loadMoreVideos() {
      try {
        const manifest = await fetchJSON<string[]>(`${VIDEO_BASE}/manifest.json`)
        const otherIds = manifest.filter((id) => id !== currentId)

        if (otherIds.length === 0) {
          if (!cancelled) setSuggestions({ state: 'empty' })
          return
        }

        const metas = await Promise.all(
          otherIds.map((id) => {
            const url = `${VIDEO_BASE}/${encodeURIComponent(id)}/meta.json`
            return fetch(url, { cache: 'no-store' })
              .then((res) => {
                if (res.status === 404) return { title: id, _folder: id } as SuggestionMeta
                if (!res.ok) return null
                return res
                  .json()
                  .then((m: VideoMeta) => ({ ...m, _folder: id }) as SuggestionMeta)
              })
              .catch(() => null)
          }),
        )
        const valid = metas.filter(Boolean) as SuggestionMeta[]

        const tagSet = new Set(currentTags.map((t) => t.toLowerCase()))
        const scored = valid.map((m) => {
          const overlap = (m.tags || []).filter((t) =>
            tagSet.has(t.toLowerCase()),
          ).length
          return { meta: m, score: overlap }
        })
        scored.sort((a, b) =>
          b.score !== a.score ? b.score - a.score : Math.random() - 0.5,
        )

        if (!cancelled)
          setSuggestions({
            state: 'ok',
            items: scored.slice(0, 5).map(({ meta: m }) => m),
          })
      } catch (e) {
        if (!cancelled) setSuggestions({ state: 'failed' })
        console.warn('loadMoreVideos:', e)
      }
    }

    loadMoreVideos()
    return () => {
      cancelled = true
    }
  }, [loaded])

  // ── Render ──────────────────────────────────────────────────────────────────

  if (!videoId) {
    return (
      <>
        <SiteHeader searchEnabled />
        <div className="player-layout" id="playerLayout">
          <div className="error-msg">
            No video specified.{' '}
            <Link href="/" style={{ color: 'var(--accent)' }}>
              Browse videos
            </Link>
          </div>
        </div>
      </>
    )
  }

  if (errorMsg) {
    return (
      <>
        <SiteHeader searchEnabled />
        <div className="player-layout" id="playerLayout">
          <div className="error-msg">
            Failed to load video.
            <br />
            <small>{errorMsg}</small>
          </div>
        </div>
      </>
    )
  }

  if (!loaded) {
    return (
      <>
        <SiteHeader searchEnabled />
        <LoadingLayout text="Loading video…" />
      </>
    )
  }

  const { id, meta, bxSources } = loaded
  const tags = meta.tags || []
  const highlights = (meta.highlightedTags || []).slice(0, 3)
  const descriptions = meta.description
    ? Array.isArray(meta.description)
      ? meta.description
      : [meta.description]
    : []

  const bxSelect =
    bxSources.length > 1 ? (
      <select
        className="bx-select"
        id="bxSelect"
        value={String(activeBxIndex)}
        onChange={(e) => setActiveBxIndex(parseInt(e.target.value))}
      >
        {bxSources.map((b, i) => (
          <option key={i} value={i}>
            {b.label}
          </option>
        ))}
      </select>
    ) : null

  return (
    <>
      <SiteHeader searchEnabled />
      <div className="player-layout" id="playerLayout">
        <div className="player-main">
          <Link href="/" className="back-btn">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="10,3 5,8 10,13" />
            </svg>
            Back to browse
          </Link>

          <div className="player-container" id="playerContainer">
            <VideoWrap
              videoSrc={`${VIDEO_BASE}/${encodeURIComponent(id)}/${encodeURIComponent(meta.videoFile || '')}`}
              hasLoadingOverlays
              videoRef={videoRef}
              canvasRef={canvasRef}
              bxWrapRef={bxWrapRef}
            />
            <PlayerControls hasFlipY bxSelect={bxSelect} duration="" />
          </div>

          <div className="video-info">
            <div className="card-highlight-tags" style={{ marginBottom: '0.6rem' }}>
              {highlights.map((t, i) => (
                <span className="card-tag" key={i}>
                  {t}
                </span>
              ))}
            </div>
            <h1 className="video-title">{meta.title || id}</h1>
            <div className="video-creator-row">
              <div className="video-creator">
                <span className="video-creator-label">Video Creator</span>
                {meta.videoCreator || 'Unknown'}
              </div>
              <div className="video-creator">
                <span className="video-creator-label">Path Creator</span>
                {meta.pathCreator || 'Unknown'}
              </div>
            </div>

            <div className="video-stats-row">
              <div className="stat-item">
                <span className="stat-label">BPM</span>
                <span className="stat-value">{meta.bpm || '–'}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Duration</span>
                <span className="stat-value" id="statDuration">
                  {stats.duration}
                </span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Frames</span>
                <span className="stat-value" id="statFrames">
                  {stats.frames}
                </span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Markers</span>
                <span className="stat-value" id="statsMarkerCount">
                  {activeMarkers.length}
                </span>
              </div>
            </div>

            {descriptions.map((p, i) => (
              <p
                className="video-description"
                key={i}
                dangerouslySetInnerHTML={{ __html: renderDescription(p) }}
              />
            ))}

            <div className="video-tags-section">
              {tags.map((t, i) => (
                <Link
                  href={`/?q=${encodeURIComponent(t)}`}
                  className="video-tag"
                  key={i}
                >
                  #{t}
                </Link>
              ))}
            </div>
          </div>
        </div>

        <aside className="player-sidebar">
          <div className="sidebar-tabs">
            <button
              className={sidebarTab === 'bx' ? 'sidebar-tab active' : 'sidebar-tab'}
              id="sidebarTabBx"
              onClick={() => setSidebarTab('bx')}
            >
              BounceX Data
            </button>
            <button
              className={
                sidebarTab === 'more' ? 'sidebar-tab active' : 'sidebar-tab'
              }
              id="sidebarTabMore"
              onClick={() => setSidebarTab('more')}
            >
              More Videos
            </button>
          </div>

          <div
            className={
              sidebarTab === 'bx' ? 'sidebar-panel active' : 'sidebar-panel'
            }
            id="sidebarPanelBx"
          >
            <DevicePanel />

            <div className="sidebar-section">
              <div className="sidebar-title">Stats</div>
              <div className="bx-stats-grid">
                <div className="bx-stat-box">
                  <div className="bx-stat-label">Markers</div>
                  <div className="bx-stat-value" id="sidebarMarkerCount">
                    {activeMarkers.length}
                  </div>
                </div>
                <div className="bx-stat-box">
                  <div className="bx-stat-label">BX File</div>
                  <div
                    className="bx-stat-value"
                    id="sidebarBxFile"
                    style={{ fontSize: '0.72rem' }}
                  >
                    {bxSources[activeBxIndex].file}
                  </div>
                </div>
                <div className="bx-stat-box">
                  <div className="bx-stat-label">Current Depth</div>
                  <div className="bx-stat-value" id="curDepth">
                    –
                  </div>
                </div>
                <div className="bx-stat-box">
                  <div className="bx-stat-label">Current Frame</div>
                  <div className="bx-stat-value" id="curFrame">
                    0
                  </div>
                </div>
              </div>
            </div>

            <div className="sidebar-section">
              <div className="sidebar-title" id="markerListTitle">
                Markers ({activeMarkers.length})
              </div>
              {/* Rows are keyed by source *and* index so switching .bx files
                  remounts them, the way the legacy innerHTML rebuild did —
                  otherwise a reused row could keep a stale `.current` class.
                  The container itself must stay put: the engine caches it.

                  Rows render only while this panel is the active tab. A clip
                  like beryllium has ~4k markers × 6 elements, and the per-frame
                  `.current` toggle below invalidates style across the whole
                  subtree — enough to cost ~35ms frames even with the panel
                  `display: none`. Measured: 135 → 144fps, p99 34.7 → 7.1ms. */}
              <div className="marker-list" id="markerList">
                {sidebarTab === 'bx' && activeMarkers.map((m, i) => (
                  <div
                    className="marker-list-item"
                    data-frame={m.frame}
                    id={`mli-${i}`}
                    key={`${activeBxIndex}-${i}`}
                    onClick={() => seekToFrame(m.frame)}
                  >
                    <span className="marker-frame-num">{m.frame}</span>
                    <div className="marker-depth-bar">
                      <div
                        className="marker-depth-fill"
                        style={{ width: `${(m.depth * 100).toFixed(1)}%` }}
                      ></div>
                    </div>
                    <span className="marker-depth-val">{m.depth.toFixed(2)}</span>
                    <span className="marker-ease-tag">
                      {easeLabel(m.trans, m.ease)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div
            className={
              sidebarTab === 'more' ? 'sidebar-panel active' : 'sidebar-panel'
            }
            id="sidebarPanelMore"
          >
            <div className="more-videos-list" id="moreVideosList">
              <MoreVideos suggestions={suggestions} />
            </div>
          </div>
        </aside>
      </div>
    </>
  )
}

const PLACEHOLDER_STYLE = {
  color: 'var(--text3)',
  fontSize: '0.75rem',
  fontFamily: 'var(--mono)',
  padding: '0.5rem 0',
} as const

function MoreVideos({ suggestions }: { suggestions: Suggestions }) {
  if (suggestions.state === 'loading')
    return <div style={PLACEHOLDER_STYLE}>Loading…</div>
  if (suggestions.state === 'empty')
    return <div style={PLACEHOLDER_STYLE}>No other videos found.</div>
  if (suggestions.state === 'failed')
    return <div style={PLACEHOLDER_STYLE}>Could not load suggestions.</div>

  return (
    <>
      {suggestions.items.map((m, idx) => {
        const folder = m._folder || m.videoId || ''
        const thumbSrc = m.thumbnail
          ? `${VIDEO_BASE}/${encodeURIComponent(folder)}/${encodeURIComponent(m.thumbnail)}`
          : null
        const highlights = (m.highlightedTags || m.tags || []).slice(0, 2)
        const dur = m.duration ? framesToTimecode(m.duration) : ''

        return (
          <Link
            className="more-video-card"
            href={`/watch?v=${encodeURIComponent(folder)}`}
            key={idx}
          >
            {thumbSrc ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                className="more-video-thumb"
                src={thumbSrc}
                alt=""
                loading="lazy"
                onError={(e) => {
                  const img = e.currentTarget
                  img.style.display = 'none'
                  const next = img.nextElementSibling as HTMLElement | null
                  if (next) next.style.display = 'flex'
                }}
              />
            ) : null}
            <div
              className="more-video-thumb-placeholder"
              style={thumbSrc ? { display: 'none' } : undefined}
            >
              ▶
            </div>
            <div className="more-video-info">
              <div className="more-video-title">{m.title || folder}</div>
              <div className="more-video-author">{m.pathCreator || ''}</div>
              <div className="more-video-tags">
                {highlights.map((t, i) => (
                  <span className="more-video-tag" key={i}>
                    {t}
                  </span>
                ))}
                {dur ? (
                  <span
                    className="more-video-tag"
                    style={{
                      background: 'rgba(255,255,255,0.05)',
                      color: 'var(--text3)',
                      borderColor: 'var(--border)',
                    }}
                  >
                    {dur}
                  </span>
                ) : null}
              </div>
            </div>
          </Link>
        )
      })}
    </>
  )
}

export default function WatchPage() {
  return (
    <Suspense
      fallback={
        <>
          <SiteHeader searchEnabled />
          <LoadingLayout text="Loading video…" />
        </>
      }
    >
      <WatchInner />
    </Suspense>
  )
}
