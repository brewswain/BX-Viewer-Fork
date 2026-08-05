'use client'

/**
 * Playlist page.
 *
 * One engine instance lives for the whole playlist; `loadTrack()` swaps the
 * video src and the bx path data underneath it rather than tearing the engine
 * down, which is what keeps volume/overlay/zoom state across tracks.
 */

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'

import DevicePanel from '@/components/player/DevicePanel'
import OssmExportPanel from '@/components/player/OssmExportPanel'
import PlayerControls from '@/components/player/PlayerControls'
import SiteHeader from '@/components/SiteHeader'
import VideoWrap from '@/components/player/VideoWrap'
import { deviceManager } from '@/lib/device/manager'
import {
  buildPath,
  loadEffectFonts,
  markersFromData,
  parseBx,
  peaksFromMarkerData,
} from '@/lib/player/bx'
import { FPS, PLAYLIST_BASE, VIDEO_BASE } from '@/lib/player/constants'
import { createPlayerEngine, type PlayerEngine } from '@/lib/player/engine'
import {
  advance,
  cycleLoopMode,
  cyclePlaylistLoopMode,
  EMPTY_PLAYLIST_PREFS,
  loadPlaylistPrefs,
  savePlaylistPrefs,
  sequentialOrder,
  shuffledOrder,
  type LoopMode,
  type PlaylistPrefs,
} from '@/lib/player/playback'
import { fetchJSON, fetchText, framesToTimecode, renderDescription } from '@/lib/player/format'
import type {
  BxEffect,
  BxFileRef,
  PlaylistMeta,
  VideoMeta,
} from '@/lib/player/types'
import type { OssmItem } from '@/lib/ossm/types'
import { deviceConfigFromSettings, getSettings } from '@/lib/settings'

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

/**
 * The .bx a track loads when the user hasn't picked a variant: per-entry
 * playlist override → first listed variant → legacy single-file field. Shared by
 * the player and the OSSM export so the two can't disagree about what's playing.
 */
function defaultBxFile(meta: TrackMeta): string | null {
  return (
    meta._bxFile ||
    (meta.bxFiles && meta.bxFiles[0] ? meta.bxFiles[0].file : null) ||
    meta.bxFile ||
    null
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
  // The user's variant picks, keyed by track index. Recorded rather than left in
  // the dropdown so a revisited track keeps its pick and the OSSM export sends
  // the paths that were actually played. The ref is what `loadTrack` reads: it
  // lives inside an effect that deliberately doesn't re-run on state changes.
  const [bxOverrides, setBxOverrides] = useState<Record<number, string>>({})
  const bxOverridesRef = useRef<Record<number, string>>({})

  // Loop / shuffle. Same ref-beside-state shape as `bxOverrides`, and for the
  // same reason: the engine effect must not re-run when a toggle flips.
  const [prefs, setPrefs] = useState<PlaylistPrefs>(EMPTY_PLAYLIST_PREFS)
  const prefsRef = useRef<PlaylistPrefs>(EMPTY_PLAYLIST_PREFS)
  /** Track indices in play order — shuffled or the identity permutation. */
  const orderRef = useRef<number[]>([])
  /** Where the playing track sits *in `orderRef`*, not its playlist index. */
  const positionRef = useRef(0)
  /** Extra plays the current track has had, for resolving a `once` repeat. */
  const repeatsUsedRef = useRef(0)

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
    bxOverridesRef.current = {}
    setBxOverrides({})
    // localStorage is client-only, so this is read here rather than seeded into
    // useState, which would run on the server and desync hydration.
    const storedPrefs = loadPlaylistPrefs(playlistId)
    prefsRef.current = storedPrefs
    setPrefs(storedPrefs)

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

    orderRef.current = prefsRef.current.shuffle
      ? shuffledOrder(metas.length)
      : sequentialOrder(metas.length)
    positionRef.current = 0

    const deviceConfig = deviceConfigFromSettings(userSettings)
    deviceManager.configure(deviceConfig)
    if (deviceConfig.enabled && deviceConfig.autoConnect) {
      void deviceManager.connect()
    }

    const engine = createPlayerEngine({
      video,
      canvas,
      bxWrap,
      userSettings,
      autoTheater: true,
      onEnded() {
        // Native looping (see the `video.loop` effect) swallows `ended`, so
        // anything that gets here either advances or has a `once` repeat left.
        const prefsNow = prefsRef.current
        const folder = metas[trackIndex]?._folder ?? ''
        const result = advance({
          order: orderRef.current,
          position: positionRef.current,
          loop: prefsNow.loop,
          trackLoop: prefsNow.tracks[folder] || 'off',
          repeatsUsed: repeatsUsedRef.current,
        })
        if (result.action === 'stop') return
        if (result.action === 'repeat') {
          repeatsUsedRef.current += 1
          video!.currentTime = 0
          engine.resetSmoothTime()
          void video!.play().catch(() => {})
          return
        }
        // Reshuffle on every pass, or repeat-all would replay one fixed order.
        if (result.wrapped && prefsNow.shuffle) {
          orderRef.current = shuffledOrder(metas.length)
        }
        loadTrack(orderRef.current[result.position])
      },
      onFrame(curFrame) {
        // Same contract as the watch page: `curFrame` is already smoothed and
        // offset-corrected, and the driver is a no-op when nothing is due.
        deviceManager.tick(
          (curFrame / FPS) * 1000,
          !video!.paused && !video!.ended && video!.readyState >= 2,
        )
      },
    })
    engineRef.current = engine

    async function loadTrack(index: number) {
      trackIndex = index
      const meta = metas[index]
      const folder = meta._folder
      // A track reached by clicking the list is not necessarily the next one in
      // play order, so the position is derived from the order rather than kept
      // in step with it.
      const atPosition = orderRef.current.indexOf(index)
      positionRef.current = atPosition >= 0 ? atPosition : 0
      repeatsUsedRef.current = 0

      // Title / authors / description / track counters all re-render from this
      setCurrentIndex(index)

      // Highlight active track in the sidebar list
      const activeEl = document.getElementById(`ptrack-${index}`)
      if (activeEl)
        activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' })

      // The user's own pick for this track wins over the meta-derived default.
      const bxFileToLoad = bxOverridesRef.current[index] ?? defaultBxFile(meta)

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
        deviceManager.setMarkers(markersFromData(markerData))
      } catch (e) {
        console.warn('Could not load bx file:', e)
        newPath = new Float32Array(newTotalFrames).fill(0)
        // A track with no usable path must not leave the previous track's plan
        // running against the new video.
        deviceManager.clearMarkers()
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
    loadTrack(orderRef.current[0] ?? 0)

    return () => {
      engine.destroy()
      engineRef.current = null
      loadTrackRef.current = null
      // The manager outlives this page; leaving it must stop the machine.
      deviceManager.clearMarkers()
    }
  }, [loaded])

  // ── Loop / shuffle ──────────────────────────────────────────────────────────

  function updatePrefs(next: PlaylistPrefs) {
    prefsRef.current = next
    setPrefs(next)
    if (playlistId) savePlaylistPrefs(playlistId, next)
  }

  /**
   * Only the modes that never advance may use the element's own loop: it is
   * gapless where an `ended` + seek is not, but it also suppresses `ended`,
   * which is where a `once` repeat is counted.
   */
  useEffect(() => {
    const video = videoRef.current
    if (!video || !loaded) return
    const folder = loaded.metas[currentIndex]?._folder
    const trackLoop = folder ? prefs.tracks[folder] || 'off' : 'off'
    video.loop = trackLoop === 'forever' || prefs.loop === 'one'
  }, [loaded, currentIndex, prefs])

  function toggleShuffle() {
    const shuffle = !prefs.shuffle
    const count = loaded?.metas.length ?? 0
    // Pin the playing track to the front so flipping shuffle mid-video does not
    // cut it off; unshuffling just restores playlist order around it.
    orderRef.current = shuffle
      ? shuffledOrder(count, currentIndex)
      : sequentialOrder(count)
    const at = orderRef.current.indexOf(currentIndex)
    positionRef.current = at >= 0 ? at : 0
    updatePrefs({ ...prefs, shuffle })
  }

  function cycleTrackRepeat(folder: string) {
    const next = cycleLoopMode(prefs.tracks[folder] || 'off')
    const tracks = { ...prefs.tracks }
    if (next === 'off') delete tracks[folder]
    else tracks[folder] = next
    // Changing the setting mid-play restarts the allowance for this pass.
    if (loaded?.metas[currentIndex]?._folder === folder) repeatsUsedRef.current = 0
    updatePrefs({ ...prefs, tracks })
  }

  /** Prev/next follow play order, and wrap only when repeat-all is on. */
  function stepTrack(delta: number) {
    const order = orderRef.current
    if (order.length === 0) return
    let pos = positionRef.current + delta
    if (pos < 0) pos = prefs.loop === 'all' ? order.length - 1 : 0
    if (pos >= order.length) pos = prefs.loop === 'all' ? 0 : order.length - 1
    loadTrackRef.current?.(order[pos])
  }

  // ── BX file dropdown (per track) ────────────────────────────────────────────
  async function onBxSelectChange(idx: number) {
    const state = bxSelect
    if (!state) return
    const b = state.options[idx]
    const frames = trackFramesRef.current
    // Record the pick before loading: the export should follow the dropdown even
    // if this .bx turns out to be unparseable.
    bxOverridesRef.current = {
      ...bxOverridesRef.current,
      [state.trackIndex]: b.file,
    }
    setBxOverrides(bxOverridesRef.current)
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
      deviceManager.setMarkers(markersFromData(markerData))
    } catch (err) {
      console.warn('Could not load bx file:', err)
    }
  }

  // Tracks with no resolvable .bx are dropped — there is no path to export.
  const ossmItems = useMemo<OssmItem[]>(() => {
    if (!loaded) return []
    return loaded.metas.flatMap((m, i) => {
      const bxFile = bxOverrides[i] ?? defaultBxFile(m)
      return bxFile ? [{ videoId: m._folder, bxFile }] : []
    })
  }, [loaded, bxOverrides])

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
              hasPlaylistDrawer
              loopMode={prefs.loop}
              onCycleLoop={() =>
                updatePrefs({ ...prefs, loop: cyclePlaylistLoopMode(prefs.loop) })
              }
              shuffle={prefs.shuffle}
              onToggleShuffle={toggleShuffle}
              totalCount={metas.length}
              trackDisplay={`${currentIndex + 1} / ${metas.length}`}
              bxSelect={bxSelectNode}
              onPrevTrack={() => stepTrack(-1)}
              onNextTrack={() => stepTrack(1)}
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
          {/* Theater-only: the engine binds it by id and hides it elsewhere. */}
          <button
            className="theater-sidebar-close"
            id="btnTheaterSidebarClose"
            title="Close playlist (Esc)"
            aria-label="Close playlist"
          >
            ×
          </button>

          <DevicePanel />

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
                    <TrackRepeatButton
                      mode={prefs.tracks[folder] || 'off'}
                      onCycle={() => cycleTrackRepeat(folder)}
                    />
                  </div>
                )
              })}
            </div>
          </div>

          <OssmExportPanel
            items={ossmItems}
            playlistTitle={playlist.title || id}
            bundleName={playlist.title || id}
          />
        </aside>
      </div>
    </>
  )
}

const TRACK_REPEAT_UI: Record<LoopMode, { title: string; badge: string | null }> = {
  off: { title: 'Repeat this video: off', badge: null },
  once: { title: 'Repeat this video: one extra play', badge: '+1' },
  forever: { title: 'Repeat this video: forever', badge: '∞' },
}

/**
 * Per-track repeat, the alternative to listing a favourite twice — playlists
 * reject duplicates, so wanting a video again has to be a setting on the row.
 */
function TrackRepeatButton({
  mode,
  onCycle,
}: {
  mode: LoopMode
  onCycle: () => void
}) {
  const ui = TRACK_REPEAT_UI[mode]
  return (
    <button
      className={mode === 'off' ? 'ptrack-repeat' : 'ptrack-repeat active'}
      title={ui.title}
      aria-label={ui.title}
      onClick={(e) => {
        // The whole row loads the track; the button must not do both.
        e.stopPropagation()
        onCycle()
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="17,2 21,6 17,10" />
        <path d="M3 12V10a4 4 0 0 1 4-4h14" />
        <polyline points="7,22 3,18 7,14" />
        <path d="M21 12v2a4 4 0 0 1-4 4H3" />
      </svg>
      {ui.badge && <span className="ptrack-repeat-badge">{ui.badge}</span>}
    </button>
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
