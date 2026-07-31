'use client'

/**
 * BounceX Viewer — Index / Browse
 *
 * Videos are discovered from a manifest at /videos/manifest.json
 * Playlists are discovered from /playlists/manifest.json
 */

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import SiteHeader from '@/components/SiteHeader'
import FilterBar, {
  emptyFilters,
  type ActiveFilters,
  type FilterKey,
} from '@/components/browse/FilterBar'
import PlaylistCard, { type PlaylistMeta } from '@/components/browse/PlaylistCard'
import VideoCard, { type VideoMeta } from '@/components/browse/VideoCard'
import ViewToggle, { type ViewMode } from '@/components/browse/ViewToggle'

const VIDEO_BASE = '/videos'
const PLAYLIST_BASE = '/playlists'
const MANAGER_API = '/api/manager/version'

// ── Helpers ────────────────────────────────────────────────────────────────
async function fetchJSON(url: string) {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

/**
 * Fetch a video's meta.json, returning a synthesised fallback if it is absent
 * (404) so that meta.json is not required for every video folder.
 */
async function fetchVideoMeta(folder: string): Promise<VideoMeta> {
  const url = `${VIDEO_BASE}/${encodeURIComponent(folder)}/meta.json`
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (res.status === 404) return defaultMeta(folder)
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return res.json()
  } catch {
    // Network error or parse failure — return safe default rather than
    // crashing the entire browse page.
    return defaultMeta(folder)
  }
}

function defaultMeta(folder: string): VideoMeta {
  return {
    title: folder,
    videoFile: `${folder}.mp4`,
    bxFiles: [{ label: 'Default', file: `${folder}.bx` }],
    // duration intentionally omitted — will be detected from the video element
  }
}

const FILTER_KEYS: FilterKey[] = [
  'videoType',
  'difficulty',
  'songQuantity',
  'pathCreator',
  'videoCreator',
  'tags',
]

function Browse() {
  const searchParams = useSearchParams()

  // ── State ────────────────────────────────────────────────────────────────
  const [videos, setVideos] = useState<VideoMeta[]>([])
  const [videosLoaded, setVideosLoaded] = useState(false)
  const [videosError, setVideosError] = useState<string | null>(null)
  /** Bumped on each successful library load so cards remount and re-animate. */
  const [libraryVersion, setLibraryVersion] = useState(0)

  const [playlists, setPlaylists] = useState<PlaylistMeta[]>([])
  const [playlistsState, setPlaylistsState] = useState<'loading' | 'ok' | 'error'>(
    'loading',
  )

  const [activeTab, setActiveTab] = useState<'videos' | 'playlists'>('videos')
  const [filters, setFilters] = useState<ActiveFilters>(emptyFilters)

  // `?q=` prefills the box verbatim; the query itself is lower-cased (legacy
  // did not trim this one).
  const [searchText, setSearchText] = useState(() => searchParams.get('q') ?? '')
  const [searchQuery, setSearchQuery] = useState(() =>
    (searchParams.get('q') ?? '').toLowerCase(),
  )

  // View mode: 'grid' | 'list' — persisted per-panel in sessionStorage
  const [videoViewMode, setVideoViewMode] = useState<ViewMode>('grid')
  const [playlistViewMode, setPlaylistViewMode] = useState<ViewMode>('grid')

  useEffect(() => {
    if (sessionStorage.getItem('bx_view_videos') === 'list') setVideoViewMode('list')
    if (sessionStorage.getItem('bx_view_playlists') === 'list')
      setPlaylistViewMode('list')
  }, [])

  const changeVideoView = useCallback((mode: ViewMode) => {
    sessionStorage.setItem('bx_view_videos', mode)
    setVideoViewMode(mode)
  }, [])

  const changePlaylistView = useCallback((mode: ViewMode) => {
    sessionStorage.setItem('bx_view_playlists', mode)
    setPlaylistViewMode(mode)
  }, [])

  // ── Boot ─────────────────────────────────────────────────────────────────
  const loadVideos = useCallback(async () => {
    try {
      const manifest: string[] = await fetchJSON(`${VIDEO_BASE}/manifest.json`)
      const metas = await Promise.all(
        manifest.map((id) =>
          fetchVideoMeta(id).then((m) => ({ ...m, _folder: id })),
        ),
      )
      setVideos(metas)
      setVideosError(null)
      setVideosLoaded(true)
      setLibraryVersion((n) => n + 1)
    } catch (e) {
      setVideosError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const loadPlaylists = useCallback(async () => {
    try {
      const manifest: string[] = await fetchJSON(`${PLAYLIST_BASE}/manifest.json`)
      const list: PlaylistMeta[] = await Promise.all(
        manifest.map((id) =>
          fetchJSON(`${PLAYLIST_BASE}/${encodeURIComponent(id)}/meta.json`).then(
            (p) => ({ ...p, _id: id }),
          ),
        ),
      )
      setPlaylists(list)
      setPlaylistsState('ok')
    } catch {
      setPlaylists([])
      setPlaylistsState('error')
    }
  }, [])

  const init = useCallback(() => {
    void loadVideos()
    void loadPlaylists()
  }, [loadVideos, loadPlaylists])

  const initRef = useRef(init)
  initRef.current = init
  useEffect(() => {
    initRef.current()
  }, [])

  // ── Live reload from Manager ─────────────────────────────────────────────
  useEffect(() => {
    let lastVersion: number | null = null

    async function poll() {
      try {
        const res = await fetch(MANAGER_API, { cache: 'no-store' })
        if (!res.ok) return
        const { version } = await res.json()
        if (lastVersion === null) {
          lastVersion = version
          return
        }
        if (version !== lastVersion) {
          lastVersion = version
          await loadVideos()
          await loadPlaylists()
        }
      } catch {
        /* manager not running */
      }
    }

    const timer = setInterval(poll, 2000)
    return () => clearInterval(timer)
  }, [loadVideos, loadPlaylists])

  // ── Grid filtering ───────────────────────────────────────────────────────
  const { videoType, difficulty, songQuantity, pathCreator, videoCreator, tags } =
    filters
  let filtered = videos
  if (videoType.size > 0)
    filtered = filtered.filter((v) => (v.tags || []).some((t) => videoType.has(t)))
  if (difficulty.size > 0)
    filtered = filtered.filter((v) => (v.tags || []).some((t) => difficulty.has(t)))

  if (songQuantity.size > 0)
    filtered = filtered.filter((v) =>
      (v.tags || []).some((t) => songQuantity.has(t)),
    )

  if (pathCreator.size > 0)
    filtered = filtered.filter((v) => pathCreator.has(v.pathCreator as string))
  if (videoCreator.size > 0)
    filtered = filtered.filter((v) => videoCreator.has(v.videoCreator as string))
  if (tags.size > 0)
    filtered = filtered.filter((v) => (v.tags || []).some((t) => tags.has(t)))

  if (searchQuery) {
    filtered = filtered.filter((v) => {
      const haystack = [
        v.title || '',
        v.pathCreator || '',
        v.videoCreator || '',
        v.description || '',
        ...(v.tags || []),
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(searchQuery)
    })
  }

  const videoCount = videosLoaded
    ? `${filtered.length} video${filtered.length !== 1 ? 's' : ''}`
    : '— videos'

  const playlistCount =
    playlistsState === 'loading'
      ? '— playlists'
      : playlistsState === 'error'
        ? '0 playlists'
        : `${playlists.length} playlist${playlists.length !== 1 ? 's' : ''}`

  // Rebuilt whenever the legacy renderGrid() would have re-created the cards,
  // so the staggered entry animation replays as it did before.
  const gridKey = `${libraryVersion}|${searchQuery}|${FILTER_KEYS.map((k) =>
    [...filters[k]].join(','),
  ).join('|')}`

  return (
    <>
      <SiteHeader
        active="browse"
        search={{
          value: searchText,
          onChange: (value) => {
            setSearchText(value)
            setSearchQuery(value.trim().toLowerCase())
          },
        }}
        onRefresh={init}
      />

      <div className="page-tabs">
        <button
          className={`page-tab${activeTab === 'videos' ? ' active' : ''}`}
          id="tabVideos"
          onClick={() => setActiveTab('videos')}
        >
          Videos
        </button>
        <button
          className={`page-tab${activeTab === 'playlists' ? ' active' : ''}`}
          id="tabPlaylists"
          onClick={() => setActiveTab('playlists')}
        >
          Playlists
        </button>
      </div>

      <main className="main-content">
        {/* Videos Panel */}
        <div
          id="panelVideos"
          style={activeTab === 'videos' ? undefined : { display: 'none' }}
        >
          <div className="section-header">
            <h1 className="section-title">All Videos</h1>
            <span className="section-count" id="videoCount">
              {videoCount}
            </span>
            <ViewToggle
              mode={videoViewMode}
              onChange={changeVideoView}
              gridBtnId="btnGridViewVideos"
              listBtnId="btnListViewVideos"
            />
          </div>
          {videosLoaded ? (
            <FilterBar videos={videos} filters={filters} onChange={setFilters} />
          ) : (
            <div className="tag-filter" id="tagFilter" />
          )}
          <div
            className={`video-grid${videoViewMode === 'list' ? ' list-view' : ''}`}
            id="videoGrid"
          >
            {videosError ? (
              <div className="error-msg">
                Could not load manifest.
                <br />
                <small>{videosError}</small>
              </div>
            ) : !videosLoaded ? (
              <div className="loading-msg">Loading videos…</div>
            ) : filtered.length === 0 ? (
              <div className="empty-state">No videos match your search.</div>
            ) : (
              filtered.map((v, i) => (
                <VideoCard
                  key={`${gridKey}::${v._folder || v.videoId || i}`}
                  video={v}
                  index={i}
                />
              ))
            )}
          </div>
        </div>

        {/* Playlists Panel */}
        <div
          id="panelPlaylists"
          style={activeTab === 'playlists' ? undefined : { display: 'none' }}
        >
          <div className="section-header">
            <h1 className="section-title">Playlists</h1>
            <span className="section-count" id="playlistCount">
              {playlistCount}
            </span>
            <ViewToggle
              mode={playlistViewMode}
              onChange={changePlaylistView}
              gridBtnId="btnGridViewPlaylists"
              listBtnId="btnListViewPlaylists"
            />
          </div>
          <div
            className={`video-grid${playlistViewMode === 'list' ? ' list-view' : ''}`}
            id="playlistGrid"
          >
            {playlistsState === 'loading' ? (
              <div className="loading-msg">Loading playlists…</div>
            ) : playlistsState === 'error' ? (
              <div className="empty-state">No playlists found.</div>
            ) : playlists.length === 0 ? (
              <div className="empty-state">No playlists yet.</div>
            ) : (
              playlists.map((p, i) => (
                <PlaylistCard key={p._id} playlist={p} index={i} />
              ))
            )}
          </div>
        </div>
      </main>
    </>
  )
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Browse />
    </Suspense>
  )
}
