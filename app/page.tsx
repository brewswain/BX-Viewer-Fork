'use client'

/**
 * BounceX Viewer — Index / Browse
 *
 * Videos are discovered from a manifest at /videos/manifest.json
 * Playlists are discovered from /playlists/manifest.json
 */

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import SiteHeader from '@/components/SiteHeader'
import Pager from '@/components/browse/Pager'
import TagSidebar from '@/components/browse/TagSidebar'
import FilterBar, {
  emptyFilters,
  type ActiveFilters,
  type FilterKey,
} from '@/components/browse/FilterBar'
import PlaylistCard, { type PlaylistMeta } from '@/components/browse/PlaylistCard'
import VideoCard, { type VideoMeta } from '@/components/browse/VideoCard'
import ViewToggle, { type ViewMode } from '@/components/browse/ViewToggle'
import { matchesSelection, type MatchMode } from '@/lib/browse/facets'
import { filterByCategory } from '@/lib/browse/tagFilter'
import { getSettings, setSettings } from '@/lib/settings'
import { loadPlaylistPrefs, savePlaylistPrefs } from '@/lib/player/playback'
import {
  QUICK_PLAYLIST_ID,
  saveQuickPlaylist,
} from '@/lib/player/quickPlaylist'

const MANAGER_API = '/api/manager/version'
const LIBRARY_API = '/api/library'

/**
 * Both manifests plus every meta.json, in one response. An absent manifest
 * comes back as an empty list rather than an error: neither one ships with the
 * repo (the manager writes them on the first import), so a fresh install has no
 * videos rather than a broken page. A folder with no readable meta.json still
 * appears, under the conventional file names the server synthesises.
 */
type LibraryResponse = {
  videos: VideoMeta[]
  playlists: PlaylistMeta[]
}

const PAGE_SIZE = 24

type Selection = { tags: string[]; mode: MatchMode }

const SEL_KEY = { videos: 'bx_browse_sel_videos', playlists: 'bx_browse_sel_playlists' }

/** The tab's own selection if it has one, else the saved default (videos only). */
function initialSelection(panel: 'videos' | 'playlists'): Selection {
  try {
    const raw = sessionStorage.getItem(SEL_KEY[panel])
    if (raw) return JSON.parse(raw) as Selection
  } catch {
    /* fall through to the default */
  }
  if (panel === 'playlists') return { tags: [], mode: 'or' }
  const s = getSettings()
  return { tags: s.browseDefaultTags, mode: s.browseDefaultMode }
}

function storeSelection(panel: 'videos' | 'playlists', sel: Selection) {
  try {
    sessionStorage.setItem(SEL_KEY[panel], JSON.stringify(sel))
  } catch {
    /* session-only convenience */
  }
}

/**
 * The page number is remembered against the filter state it was picked under,
 * so any change to filters, search or the sidebar lands back on page 1 without
 * an effect racing the render.
 */
function usePage(filterKey: string) {
  const [state, setState] = useState({ key: filterKey, page: 1 })
  const page = state.key === filterKey ? state.page : 1
  const setPage = useCallback(
    (p: number) => {
      setState({ key: filterKey, page: p })
      window.scrollTo({ top: 0 })
    },
    [filterKey],
  )
  return [page, setPage] as const
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

  // Seeded empty so the server render matches; the real selection comes from
  // storage on mount, before the library request can resolve.
  const [videoSel, setVideoSel] = useState<Selection>({ tags: [], mode: 'or' })
  const [playlistSel, setPlaylistSel] = useState<Selection>({ tags: [], mode: 'or' })
  useEffect(() => {
    // A tag link from the watch page selects just that tag; a search link has
    // to see the whole library, or the default selection would hide its hits.
    const tag = searchParams.get('tag')
    if (tag) setVideoSel({ tags: [tag.toLowerCase()], mode: 'or' })
    else if (searchParams.get('q')) setVideoSel({ tags: [], mode: 'or' })
    else setVideoSel(initialSelection('videos'))
    setPlaylistSel(initialSelection('playlists'))
  }, [searchParams])

  const changeVideoSel = useCallback((tags: string[], mode: MatchMode) => {
    const sel = { tags, mode }
    storeSelection('videos', sel)
    setVideoSel(sel)
  }, [])

  const changePlaylistSel = useCallback((tags: string[], mode: MatchMode) => {
    const sel = { tags, mode }
    storeSelection('playlists', sel)
    setPlaylistSel(sel)
  }, [])

  const resetVideoSel = useCallback(() => {
    const s = getSettings()
    changeVideoSel(s.browseDefaultTags, s.browseDefaultMode)
  }, [changeVideoSel])

  const saveVideoSelAsDefault = useCallback(() => {
    setSettings({ browseDefaultTags: videoSel.tags, browseDefaultMode: videoSel.mode })
  }, [videoSel])

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
  /**
   * One request for the whole library. This used to be a manifest fetch
   * followed by one meta.json per entry, 81 requests across videos and
   * playlists, and the manager poll below re-ran the lot on every save. The
   * server does the same walk in about 16 ms and answers it whole; see
   * `app/api/library/route.ts` for why it is not cached.
   */
  const loadLibrary = useCallback(async () => {
    let payload: LibraryResponse
    try {
      const res = await fetch(LIBRARY_API, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${LIBRARY_API}`)
      payload = await res.json()
    } catch (e) {
      setVideosError(e instanceof Error ? e.message : String(e))
      setPlaylists([])
      setPlaylistsState('error')
      return
    }
    setVideos(payload.videos || [])
    setVideosError(null)
    setVideosLoaded(true)
    setLibraryVersion((n) => n + 1)
    setPlaylists(payload.playlists || [])
    setPlaylistsState('ok')
  }, [])

  const init = useCallback(() => {
    void loadLibrary()
  }, [loadLibrary])

  const initRef = useRef(init)
  initRef.current = init
  useEffect(() => {
    initRef.current()
  }, [])

  // ── Live reload from Manager ─────────────────────────────────────────────
  useEffect(() => {
    let lastVersion: number | null = null

    async function poll() {
      // A hidden tab cannot show a change, and the reload it would trigger is
      // the most expensive thing on this page.
      if (document.hidden) return
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
          await loadLibrary()
        }
      } catch {
        /* manager not running */
      }
    }

    const timer = setInterval(poll, 2000)
    // Catch up immediately on return rather than waiting out the interval.
    const onVisible = () => {
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadLibrary])

  // ── Grid filtering ───────────────────────────────────────────────────────
  const { videoType, difficulty, songQuantity, pathCreator, videoCreator, tags } =
    filters
  let filtered = videos
  filtered = filterByCategory(filtered, videoType)
  filtered = filterByCategory(filtered, difficulty)
  filtered = filterByCategory(filtered, songQuantity)

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

  // The sidebar narrows what the dropdowns and search left, and counts against
  // that same list so its numbers say what a click would show.
  const sidebarBase = filtered
  filtered = filtered.filter((v) => matchesSelection(v.tags, videoSel.tags, videoSel.mode))

  const videoCount = videosLoaded
    ? `${filtered.length} video${filtered.length !== 1 ? 's' : ''}`
    : '— videos'

  const isFiltered =
    searchQuery !== '' ||
    videoSel.tags.length > 0 ||
    FILTER_KEYS.some((k) => filters[k].size > 0)

  const playAllDisabled = !videosLoaded || filtered.length === 0

  /**
   * Hand what is on screen — filters, search and grid order included — to the
   * playlist page, without making the user build a real playlist in the
   * manager. Runs on click, before the <Link> navigates.
   *
   * The navigation itself is a <Link> rather than router.push: every card in
   * the grid probes its video for a duration, and those setState calls land
   * unpredictably for seconds after load. A cold push has to await its RSC
   * fetch, and the probes interrupt that transition often enough that the
   * navigation silently never commits — clicking did nothing about half the
   * time. Link prefetches the payload, so the transition commits immediately
   * and has no window to be starved in.
   *
   * The shuffle variant writes the pref here rather than toggling it on
   * arrival, so the very first track already comes from a shuffled order
   * instead of being track 1 every time.
   */
  function prepareQuickPlaylist(shuffle: boolean) {
    saveQuickPlaylist({
      title: isFiltered ? 'Filtered videos' : 'All videos',
      folders: filtered.map((v) => v._folder || v.videoId || '').filter(Boolean),
    })
    if (shuffle)
      savePlaylistPrefs(QUICK_PLAYLIST_ID, {
        ...loadPlaylistPrefs(QUICK_PLAYLIST_ID),
        shuffle: true,
      })
  }

  /** <a> has no `disabled`, so an empty grid has to refuse the click itself. */
  function onPlayAllClick(e: React.MouseEvent, shuffle: boolean) {
    if (playAllDisabled) {
      e.preventDefault()
      return
    }
    prepareQuickPlaylist(shuffle)
  }

  const filteredPlaylists = playlists.filter((p) =>
    matchesSelection(p.tags, playlistSel.tags, playlistSel.mode),
  )
  const playlistTotal = filteredPlaylists.length
  const playlistCount =
    playlistsState === 'loading'
      ? '— playlists'
      : playlistsState === 'error'
        ? '0 playlists'
        : `${playlistTotal} playlist${playlistTotal !== 1 ? 's' : ''}`

  // Rebuilt whenever the legacy renderGrid() would have re-created the cards,
  // so the staggered entry animation replays as it did before.
  const filterKey = `${searchQuery}|${videoSel.mode}:${videoSel.tags.join(',')}|${FILTER_KEYS.map(
    (k) => [...filters[k]].join(','),
  ).join('|')}`
  const [videoPage, setVideoPage] = usePage(filterKey)
  const videoPageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const shownVideos = filtered.slice((videoPage - 1) * PAGE_SIZE, videoPage * PAGE_SIZE)
  const gridKey = `${libraryVersion}|${filterKey}|${videoPage}`

  const [playlistPage, setPlaylistPage] = usePage(
    `${playlistSel.mode}:${playlistSel.tags.join(',')}`,
  )
  const playlistPageCount = Math.max(1, Math.ceil(filteredPlaylists.length / PAGE_SIZE))
  const shownPlaylists = filteredPlaylists.slice(
    (playlistPage - 1) * PAGE_SIZE,
    playlistPage * PAGE_SIZE,
  )

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
            <div className="section-actions">
              <div className="play-all">
                <Link
                  className="play-all-btn"
                  id="btnPlayAll"
                  href={`/playlist?p=${QUICK_PLAYLIST_ID}`}
                  aria-disabled={playAllDisabled || undefined}
                  title={
                    isFiltered
                      ? 'Play the filtered videos as a temporary playlist'
                      : 'Play the whole library as a temporary playlist'
                  }
                  onClick={(e) => onPlayAllClick(e, false)}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
                    <polygon points="6,4 20,12 6,20" />
                  </svg>
                  Play all
                </Link>
                <Link
                  className="play-all-btn play-all-shuffle"
                  id="btnShuffleAll"
                  href={`/playlist?p=${QUICK_PLAYLIST_ID}`}
                  aria-disabled={playAllDisabled || undefined}
                  title="Shuffle the same videos"
                  aria-label="Shuffle all"
                  onClick={(e) => onPlayAllClick(e, true)}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    width="14"
                    height="14"
                  >
                    <polyline points="16,3 21,3 21,8" />
                    <line x1="4" y1="20" x2="21" y2="3" />
                    <polyline points="21,16 21,21 16,21" />
                    <line x1="15" y1="15" x2="21" y2="21" />
                    <line x1="4" y1="4" x2="9" y2="9" />
                  </svg>
                </Link>
              </div>
              <ViewToggle
                mode={videoViewMode}
                onChange={changeVideoView}
                gridBtnId="btnGridViewVideos"
                listBtnId="btnListViewVideos"
              />
            </div>
          </div>
          <div className="browse-layout">
            <TagSidebar
              entries={sidebarBase}
              selected={videoSel.tags}
              mode={videoSel.mode}
              onChange={changeVideoSel}
              onDefault={resetVideoSel}
              onSaveDefault={saveVideoSelAsDefault}
            />
            <div className="browse-main">
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
                  shownVideos.map((v, i) => (
                    <VideoCard
                      key={`${gridKey}::${v._folder || v.videoId || i}`}
                      video={v}
                      index={i}
                    />
                  ))
                )}
              </div>
              <Pager page={videoPage} pageCount={videoPageCount} onPage={setVideoPage} />
            </div>
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
          <div className="browse-layout">
            <TagSidebar
              entries={playlists}
              selected={playlistSel.tags}
              mode={playlistSel.mode}
              onChange={changePlaylistSel}
            />
            <div className="browse-main">
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
                ) : filteredPlaylists.length === 0 ? (
                  <div className="empty-state">No playlists match these tags.</div>
                ) : (
                  shownPlaylists.map((p, i) => (
                    <PlaylistCard key={`${playlistPage}::${p._id}`} playlist={p} index={i} />
                  ))
                )}
              </div>
              <Pager
                page={playlistPage}
                pageCount={playlistPageCount}
                onPage={setPlaylistPage}
              />
            </div>
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
