'use client'

/**
 * Playlist page — port of app/playlist.html + app/playlist.js.
 *
 * One engine instance lives for the whole playlist; `loadTrack()` swaps the
 * video src and the bx path data underneath it rather than tearing the engine
 * down, which is what keeps volume/overlay/zoom state across tracks.
 */

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useRef, useState } from 'react'

import PlayerControls from '@/components/player/PlayerControls'
import SiteHeader from '@/components/SiteHeader'
import VideoWrap from '@/components/player/VideoWrap'
import {
  buildPath,
  loadEffectFonts,
  parseBx,
  peaksFromMarkerData,
} from '@/lib/player/bx'
import { PLAYLIST_BASE, VIDEO_BASE } from '@/lib/player/constants'
import { createPlayerEngine, type PlayerEngine } from '@/lib/player/engine'
import { fetchJSON, fetchText, framesToTimecode, renderDescription } from '@/lib/player/format'
import type {
  BxEffect,
  BxFileRef,
  PlaylistMeta,
  VideoMeta,
} from '@/lib/player/types'
import { getSettings } from '@/lib/settings'

type TrackMeta = VideoMeta & { _folder: string; _bxFile: string | null }

type Loaded = { id: string; playlist: PlaylistMeta; metas: TrackMeta[] }

type BxSelectState = {
  folder: string
  options: BxFileRef[]
  selectedIdx: number
  trackIndex: number
} | null

function LoadingLayout({ text }: { text: string }) {
  return (
    <div id="playerLayout" className="player-layout">
      <div className="loading-msg">{text}</div>
    </div>
  )
}

function descriptionParagraphs(meta: VideoMeta | undefined): string[] {
  if (!meta || !meta.description) return []
  return Array.isArray(meta.description) ? meta.description : [meta.description]
}

function PlaylistInner() {
  const searchParams = useSearchParams()
  const playlistId = searchParams.get('p')

  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [emptyPlaylist, setEmptyPlaylist] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [bxSelect, setBxSelect] = useState<BxSelectState>(null)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const bxWrapRef = useRef<HTMLDivElement | null>(null)

  const engineRef = useRef<PlayerEngine | null>(null)
  const loadTrackRef = useRef<((index: number) => void) | null>(null)
  const trackFramesRef = useRef(14400)

  // ── Load playlist + every video meta ────────────────────────────────────────
  useEffect(() => {
    if (!playlistId) return
    let cancelled = false

    setLoaded(null)
    setErrorMsg(null)
    setEmptyPlaylist(false)
    setCurrentIndex(0)
    setBxSelect(null)

    async function loadPlaylist(id: string) {
      try {
        const playlist = await fetchJSON<PlaylistMeta>(
          `${PLAYLIST_BASE}/${encodeURIComponent(id)}/meta.json`,
        )
        const videos = playlist.videos || []

        if (videos.length === 0) {
          if (!cancelled) setEmptyPlaylist(true)
          return
        }

        const metas = await Promise.all(
          videos.map((entry) => {
            const folder = (
              typeof entry === 'string' ? entry : entry.id || entry.videoId
            ) as string
            const bxOverride =
              typeof entry === 'string' ? null : entry.bxFile || null
            return fetchJSON<VideoMeta>(
              `${VIDEO_BASE}/${encodeURIComponent(folder)}/meta.json`,
            ).then((m) => ({
              ...m,
              _folder: folder,
              _bxFile: bxOverride,
            }))
          }),
        )

        document.title = `${playlist.title || id} — BounceX Viewer`

        if (cancelled) return
        setLoaded({ id, playlist, metas })
      } catch (e) {
        if (cancelled) return
        setErrorMsg((e as Error).message)
        console.error(e)
      }
    }

    loadPlaylist(playlistId)
    return () => {
      cancelled = true
    }
  }, [playlistId])

  // ── Engine + track loading ──────────────────────────────────────────────────
  useEffect(() => {
    if (!loaded) return
    const video = videoRef.current
    const canvas = canvasRef.current
    const bxWrap = bxWrapRef.current
    if (!video || !canvas || !bxWrap) return

    const { metas } = loaded
    const userSettings = getSettings()
    let trackIndex = 0

    const engine = createPlayerEngine({
      video,
      canvas,
      bxWrap,
      userSettings,
      onEnded() {
        // Auto-advance to next track
        if (trackIndex < metas.length - 1) loadTrack(trackIndex + 1)
      },
    })
    engineRef.current = engine

    async function loadTrack(index: number) {
      trackIndex = index
      const meta = metas[index]
      const folder = meta._folder

      // Title / authors / description / track counters all re-render from this
      setCurrentIndex(index)

      // Highlight active track in the sidebar list
      const activeEl = document.getElementById(`ptrack-${index}`)
      if (activeEl)
        activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' })

      // Determine which bx file to load: per-entry override → first bxFiles entry → bxFile
      const bxFileToLoad =
        meta._bxFile ||
        (meta.bxFiles && meta.bxFiles[0] ? meta.bxFiles[0].file : null) ||
        meta.bxFile

      let newPath: Float32Array
      let newEffects: BxEffect[] = []
      let newPeaks: number[] = []
      const newTotalFrames =
        meta.durationSecs != null
          ? Math.round(meta.durationSecs * 60)
          : meta.duration || 14400
      trackFramesRef.current = newTotalFrames
      try {
        const bxRaw = await fetchText(
          `${VIDEO_BASE}/${encodeURIComponent(folder)}/${encodeURIComponent(String(bxFileToLoad))}`,
        )
        const { markerData, effects } = parseBx(JSON.parse(bxRaw))
        newPath = buildPath(markerData, newTotalFrames)
        newEffects = effects
        await loadEffectFonts(effects, folder)
        newPeaks = peaksFromMarkerData(markerData)
      } catch (e) {
        console.warn('Could not load bx file:', e)
        newPath = new Float32Array(newTotalFrames).fill(0)
      }

      engine.loadBxData(newPath, newTotalFrames, newEffects, newPeaks)
      // meta.offset is milliseconds (the manager's Offset field is labelled "ms");
      // setOffset takes seconds. The legacy playlist page passed it raw, so any
      // offset came out 1000x too large and the path never started.
      engine.setOffset(typeof meta.offset === 'number' ? meta.offset / 1000 : 0)
      engine.resetSmoothTime()

      // Rebuild the bx-file dropdown for this track (shown when a track has multiple .bx files)
      const bxSources =
        meta.bxFiles && meta.bxFiles.length > 1 ? meta.bxFiles : null
      if (bxSources) {
        setBxSelect({
          folder,
          options: bxSources,
          selectedIdx: bxSources.findIndex((b) => b.file === bxFileToLoad),
          trackIndex: index,
        })
      } else {
        setBxSelect(null)
      }

      // Load and play the video
      video!.src = `${VIDEO_BASE}/${encodeURIComponent(folder)}/${encodeURIComponent(meta.videoFile || '')}`
      video!.load()
      engine.resizeCanvas()
      video!.play().catch(() => {})
    }

    loadTrackRef.current = loadTrack

    // ── Start first track ─────────────────────────────────────────────────────
    loadTrack(0)

    return () => {
      engine.destroy()
      engineRef.current = null
      loadTrackRef.current = null
    }
  }, [loaded])

  // ── BX file dropdown (per track) ────────────────────────────────────────────
  async function onBxSelectChange(idx: number) {
    const state = bxSelect
    if (!state) return
    const b = state.options[idx]
    const frames = trackFramesRef.current
    try {
      const rawSel = await fetchText(
        `${VIDEO_BASE}/${encodeURIComponent(state.folder)}/${encodeURIComponent(b.file)}`,
      )
      const { markerData, effects } = parseBx(JSON.parse(rawSel))
      const peaksSel = peaksFromMarkerData(markerData)
      engineRef.current?.loadBxData(
        buildPath(markerData, frames),
        frames,
        effects,
        peaksSel,
      )
    } catch (err) {
      console.warn('Could not load bx file:', err)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (!playlistId) {
    return (
      <>
        <SiteHeader />
        <div id="playerLayout" className="player-layout">
          <div className="error-msg">
            No playlist specified.{' '}
            <Link href="/" style={{ color: 'var(--accent)' }}>
              Browse
            </Link>
          </div>
        </div>
      </>
    )
  }

  if (errorMsg) {
    return (
      <>
        <SiteHeader />
        <div id="playerLayout" className="player-layout">
          <div className="error-msg">
            Failed to load playlist.
            <br />
            <small>{errorMsg}</small>
          </div>
        </div>
      </>
    )
  }

  if (emptyPlaylist) {
    return (
      <>
        <SiteHeader />
        <div id="playerLayout" className="player-layout">
          <div className="error-msg">This playlist has no videos.</div>
        </div>
      </>
    )
  }

  if (!loaded) {
    return (
      <>
        <SiteHeader />
        <LoadingLayout text="Loading playlist…" />
      </>
    )
  }

  const { id, playlist, metas } = loaded
  const current = metas[currentIndex] ?? metas[0]

  const bxSelectNode = bxSelect ? (
    <select
      className="bx-select"
      id="bxSelect"
      key={bxSelect.trackIndex}
      defaultValue={String(bxSelect.selectedIdx)}
      onChange={(e) => onBxSelectChange(parseInt(e.target.value))}
    >
      {bxSelect.options.map((b, i) => (
        <option key={i} value={i}>
          {b.label}
        </option>
      ))}
    </select>
  ) : null

  return (
    <>
      <SiteHeader />
      <div id="playerLayout" className="player-layout">
        <div className="player-main">
          <Link href="/" className="back-btn">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="10,3 5,8 10,13" />
            </svg>
            Back to browse
          </Link>

          <div className="player-container" id="playerContainer">
            <VideoWrap
              videoRef={videoRef}
              canvasRef={canvasRef}
              bxWrapRef={bxWrapRef}
            />
            <PlayerControls
              hasPrevNext
              hasFlipY
              totalCount={metas.length}
              trackDisplay={`${currentIndex + 1} / ${metas.length}`}
              bxSelect={bxSelectNode}
              onPrevTrack={() => {
                if (currentIndex > 0) loadTrackRef.current?.(currentIndex - 1)
              }}
              onNextTrack={() => {
                if (currentIndex < metas.length - 1)
                  loadTrackRef.current?.(currentIndex + 1)
              }}
            />
          </div>

          <div className="video-info">
            <h1 className="video-title" id="plCurrentTitle">
              {current.title || current._folder}
            </h1>
            <div className="video-creator-row" id="plCurrentAuthors">
              <div className="video-creator">
                <span className="video-creator-label">Video Creator</span>
                {current.videoCreator || 'Unknown'}
              </div>
              <div className="video-creator">
                <span className="video-creator-label">Path Creator</span>
                {current.pathCreator || 'Unknown'}
              </div>
            </div>
            <div className="video-stats-row">
              <div className="stat-item">
                <span className="stat-label">Playlist</span>
                <span className="stat-value">{playlist.title || id}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Videos</span>
                <span className="stat-value">{metas.length}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">Track</span>
                <span className="stat-value" id="plTrackNum">
                  {`${currentIndex + 1} / ${metas.length}`}
                </span>
              </div>
            </div>
            <div id="videoDescContainer">
              {descriptionParagraphs(current).map((p, i) => (
                <p
                  className="video-description"
                  key={i}
                  dangerouslySetInnerHTML={{ __html: renderDescription(p) }}
                />
              ))}
            </div>
            {playlist.description ? (
              <p className="video-description" style={{ marginTop: '1rem' }}>
                <strong>Playlist Description:</strong> {playlist.description}
              </p>
            ) : null}
          </div>
        </div>

        <aside className="player-sidebar">
          <div className="sidebar-section">
            <div className="sidebar-title">
              {`${playlist.title || 'Playlist'} — ${metas.length} videos`}
            </div>
            <div className="playlist-track-list" id="playlistTrackList">
              {metas.map((m, i) => {
                const folder = m._folder
                const thumbSrc = m.thumbnail
                  ? `${VIDEO_BASE}/${encodeURIComponent(folder)}/${encodeURIComponent(m.thumbnail)}`
                  : null
                const timecode =
                  m.durationSecs != null
                    ? framesToTimecode(Math.round(m.durationSecs * 60))
                    : framesToTimecode(m.duration || 0)
                return (
                  <div
                    className={
                      i === currentIndex
                        ? 'playlist-track-item active'
                        : 'playlist-track-item'
                    }
                    id={`ptrack-${i}`}
                    data-index={i}
                    key={i}
                    onClick={() => loadTrackRef.current?.(i)}
                  >
                    <div className="ptrack-num">{i + 1}</div>
                    <div className="ptrack-thumb">
                      {thumbSrc ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={thumbSrc}
                          alt=""
                          loading="lazy"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none'
                          }}
                        />
                      ) : (
                        <div className="ptrack-thumb-placeholder"></div>
                      )}
                    </div>
                    <div className="ptrack-info">
                      <div className="ptrack-title">{m.title || folder}</div>
                      <div className="ptrack-author">
                        {m.pathCreator || 'Unknown'}
                      </div>
                    </div>
                    <div className="ptrack-duration">{timecode}</div>
                  </div>
                )
              })}
            </div>
          </div>
        </aside>
      </div>
    </>
  )
}

export default function PlaylistPage() {
  return (
    <Suspense
      fallback={
        <>
          <SiteHeader />
          <LoadingLayout text="Loading playlist…" />
        </>
      }
    >
      <PlaylistInner />
    </Suspense>
  )
}
