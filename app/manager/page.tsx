'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import SiteHeader from '@/components/SiteHeader'
import ContentList, { type ItemRow } from '@/components/manager/ContentList'
import CreateExportOverlay, {
  type ExportOverlayApi,
} from '@/components/manager/CreateExportOverlay'
import CreatePlaylistOverlay, {
  type PlaylistOverlayApi,
} from '@/components/manager/CreatePlaylistOverlay'
import CreateVideoOverlay, {
  type VideoOverlayApi,
} from '@/components/manager/CreateVideoOverlay'
import MetaPanel, { type MetaContext } from '@/components/manager/MetaPanel'
import OssmExportOverlay, {
  type OssmExportOverlayApi,
} from '@/components/manager/OssmExportOverlay'
import {
  ConfirmDialog,
  DropOverlay,
  ImportOverlay,
  type PendingDelete,
} from '@/components/manager/Overlays'
import Toast, { type ToastData } from '@/components/manager/Toast'
import {
  MANAGER_API,
  errMessage,
  fetchPlaylists,
  fetchVideos,
  type ImportResult,
  type ItemType,
  type PlaylistMeta,
  type Section,
  type VideoMeta,
} from '@/lib/manager-client'

type LoadError = { msg: string; detail: string }

export default function ManagerPage() {
  const [tab, setTab] = useState<'videos' | 'playlists'>('videos')
  const [search, setSearch] = useState('')

  // `null` means "loading" — the legacy page blanked the list before fetching.
  const [videos, setVideos] = useState<VideoMeta[] | null>(null)
  const [playlists, setPlaylists] = useState<PlaylistMeta[] | null>(null)
  const [videoError, setVideoError] = useState<LoadError | null>(null)
  const [playlistError, setPlaylistError] = useState<LoadError | null>(null)
  const [videoCount, setVideoCount] = useState('')
  const [playlistCount, setPlaylistCount] = useState('')
  const [videoHighlight, setVideoHighlight] = useState<string[]>([])
  const [playlistHighlight, setPlaylistHighlight] = useState<string[]>([])

  const [toast, setToast] = useState<ToastData | null>(null)
  const [toastVisible, setToastVisible] = useState(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [metaContext, setMetaContext] = useState<MetaContext | null>(null)

  const [dropActive, setDropActive] = useState(false)
  const [importActive, setImportActive] = useState(false)
  const [importMessage, setImportMessage] = useState('Importing…')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const videoOverlay = useRef<VideoOverlayApi | null>(null)
  const playlistOverlay = useRef<PlaylistOverlayApi | null>(null)
  const exportOverlay = useRef<ExportOverlayApi | null>(null)
  const ossmOverlay = useRef<OssmExportOverlayApi | null>(null)

  // ── Toast ──────────────────────────────────────────────────────────────────

  const showToast = useCallback(
    (type: ToastData['type'], title: string, body: ToastData['body']) => {
      setToast({ type, title, body })
      setToastVisible(true)
      if (toastTimer.current) clearTimeout(toastTimer.current)
      toastTimer.current = setTimeout(() => setToastVisible(false), 5000)
    },
    [],
  )

  // ── Load ───────────────────────────────────────────────────────────────────

  const loadVideos = useCallback(async (highlightIds: string[] = []) => {
    try {
      const data = await fetchVideos()
      setVideoCount(`(${data.length})`)
      setVideos(data)
      setVideoError(null)
      setVideoHighlight(highlightIds)
    } catch (e) {
      setVideoError({ msg: 'Failed to load videos', detail: errMessage(e) })
    }
  }, [])

  const loadPlaylists = useCallback(async (highlightIds: string[] = []) => {
    try {
      const data = await fetchPlaylists()
      setPlaylistCount(`(${data.length})`)
      setPlaylists(data)
      setPlaylistError(null)
      setPlaylistHighlight(highlightIds)
    } catch (e) {
      setPlaylistError({ msg: 'Failed to load playlists', detail: errMessage(e) })
    }
  }, [])

  const loadAll = useCallback(
    async (newVideoIds: string[] = [], newPlaylistIds: string[] = []) => {
      // showLoading() blanked both lists unconditionally, error state included.
      setVideos(null)
      setPlaylists(null)
      setVideoError(null)
      setPlaylistError(null)
      await Promise.all([loadVideos(newVideoIds), loadPlaylists(newPlaylistIds)])
    },
    [loadVideos, loadPlaylists],
  )

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  // Re-fetch whenever the page becomes visible again (handles bfcache
  // restores when navigating back, and tab switching).
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) void loadAll()
    }
    const onVisibility = () => {
      if (!document.hidden) void loadAll()
    }
    window.addEventListener('pageshow', onPageShow)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pageshow', onPageShow)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [loadAll])

  // ── Import ─────────────────────────────────────────────────────────────────

  const importZip = useCallback(
    async (file: File) => {
      if (!file || !file.name.endsWith('.zip')) {
        showToast('error', 'Invalid file', 'Please select a .zip file.')
        return
      }

      setImportMessage(`Importing ${file.name}…`)
      setImportActive(true)

      try {
        const res = await fetch(`${MANAGER_API}/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/zip' },
          body: file,
        })
        const result: ImportResult = await res.json()
        setImportActive(false)

        if (result.error) {
          showToast('error', 'Import failed', result.error)
          return
        }

        const { added_videos, added_playlists, skipped } = result
        const totalAdded = added_videos.length + added_playlists.length

        if (totalAdded === 0 && skipped.length === 0) {
          showToast(
            'error',
            'Nothing imported',
            'No videos or playlists folders found in the zip.',
          )
          return
        }

        await loadAll(added_videos, added_playlists)

        if (added_videos.length > 0 && added_playlists.length === 0)
          setTab('videos')
        else if (added_playlists.length > 0 && added_videos.length === 0)
          setTab('playlists')

        const lines = []
        if (added_videos.length)
          lines.push({
            count: added_videos.length,
            label: `video${added_videos.length !== 1 ? 's' : ''}`,
            ids: added_videos,
          })
        if (added_playlists.length)
          lines.push({
            count: added_playlists.length,
            label: `playlist${added_playlists.length !== 1 ? 's' : ''}`,
            ids: added_playlists,
          })
        if (skipped.length)
          lines.push({
            count: skipped.length,
            label: `skipped (already exist${skipped.length !== 1 ? '' : 's'})`,
            ids: skipped.map((s) => s.id),
            dim: true,
          })

        showToast(
          'success',
          `${totalAdded} item${totalAdded !== 1 ? 's' : ''} imported`,
          lines,
        )
      } catch (e) {
        setImportActive(false)
        showToast('error', 'Import failed', errMessage(e))
      }
    },
    [loadAll, showToast],
  )

  // ── Drag and drop (zip import) ─────────────────────────────────────────────

  useEffect(() => {
    let dragCounter = 0
    const isFileDrag = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')

    const onDragEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      dragCounter++
      if (dragCounter === 1) setDropActive(true)
    }
    const onDragLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      dragCounter--
      if (dragCounter === 0) setDropActive(false)
    }
    const onDragOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      dragCounter = 0
      setDropActive(false)
      const file = e.dataTransfer?.files[0]
      if (file) void importZip(file)
    }

    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('drop', onDrop)
    }
  }, [importZip])

  // ── Escape closes the transient panels ─────────────────────────────────────

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPendingDelete(null)
        setMetaContext(null)
        playlistOverlay.current?.close()
        exportOverlay.current?.close()
        ossmOverlay.current?.close()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // ── Delete ─────────────────────────────────────────────────────────────────

  async function executeDelete() {
    if (!pendingDelete) return
    const { type, id } = pendingDelete
    setPendingDelete(null)

    const endpoint =
      type === 'video'
        ? `${MANAGER_API}/videos/${encodeURIComponent(id)}`
        : `${MANAGER_API}/playlists/${encodeURIComponent(id)}`

    try {
      const res = await fetch(endpoint, { method: 'DELETE', cache: 'no-store' })
      const result = await res.json()
      if (result.error) {
        showToast('error', 'Delete failed', result.error)
        return
      }
      showToast(
        'success',
        `${type === 'video' ? 'Video' : 'Playlist'} deleted`,
        `"${id}" has been removed.`,
      )
      if (type === 'video') await loadVideos()
      else await loadPlaylists()
    } catch (e) {
      showToast('error', 'Delete failed', errMessage(e))
    }
  }

  // ── Reorder ────────────────────────────────────────────────────────────────

  async function persistReorder(section: Section, newOrder: string[]) {
    try {
      const res = await fetch(`${MANAGER_API}/${section}/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newOrder),
        cache: 'no-store',
      })
      const result = await res.json()
      if (result.error) showToast('error', 'Reorder failed', result.error)
    } catch (err) {
      showToast('error', 'Reorder failed', errMessage(err))
    }
  }

  function reorderVideos(newOrder: string[]) {
    setVideos((prev) => {
      if (!prev) return prev
      const byId = new Map(prev.map((v) => [v._folder, v]))
      return newOrder.map((id) => byId.get(id)!).filter(Boolean)
    })
    void persistReorder('videos', newOrder)
  }

  function reorderPlaylists(newOrder: string[]) {
    setPlaylists((prev) => {
      if (!prev) return prev
      const byId = new Map(prev.map((p) => [p._id, p]))
      return newOrder.map((id) => byId.get(id)!).filter(Boolean)
    })
    void persistReorder('playlists', newOrder)
  }

  // ── Rows ───────────────────────────────────────────────────────────────────

  const videoRows: ItemRow[] | null =
    videos === null
      ? null
      : videos.map((v) => ({
          id: v._folder,
          title: v.title || v._folder,
          sub:
            [
              v.pathCreator && `Path: ${v.pathCreator}`,
              v.videoCreator && `Video: ${v.videoCreator}`,
            ]
              .filter(Boolean)
              .join('  ·  ') || v._folder,
          search: [v.title, v._folder, v.pathCreator, v.videoCreator]
            .filter(Boolean)
            .join(' ')
            .toLowerCase(),
          errors: v._errors || [],
          warnings: v._warnings || [],
        }))

  const playlistRows: ItemRow[] | null =
    playlists === null
      ? null
      : playlists.map((p) => {
          const count = (p.videos || []).length
          return {
            id: p._id,
            title: p.title || p._id,
            sub:
              [
                p.author && `by ${p.author}`,
                count ? `${count} video${count !== 1 ? 's' : ''}` : null,
              ]
                .filter(Boolean)
                .join('  ·  ') || p._id,
            search: [p.title, p._id, p.author]
              .filter(Boolean)
              .join(' ')
              .toLowerCase(),
            errors: p._errors || [],
            warnings: p._warnings || [],
          }
        })

  function confirmDelete(type: ItemType, id: string) {
    setPendingDelete({ type, id })
  }

  return (
    <>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        id="fileInput"
        accept=".zip"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void importZip(file)
          e.target.value = ''
        }}
      />

      <DropOverlay active={dropActive} />
      <ImportOverlay active={importActive} message={importMessage} />

      <ConfirmDialog
        pending={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={executeDelete}
      />

      <Toast data={toast} visible={toastVisible} />

      <MetaPanel
        context={metaContext}
        onClose={() => setMetaContext(null)}
        showToast={showToast}
        onSaved={(type) => {
          if (type === 'video') void loadVideos()
          else void loadPlaylists()
        }}
      />

      <div className="manager-layout">
        <SiteHeader
          active="manager"
          search={{ value: search, onChange: setSearch }}
          searchPlaceholder="search videos, playlists…"
          // Legacy setStatusOk/setStatusError were driven by the video load only.
          status={videoError ? 'error' : 'ok'}
        />

        <div className="manager-tabs">
          <button
            className={'page-tab' + (tab === 'videos' ? ' active' : '')}
            id="tabVideos"
            onClick={() => setTab('videos')}
          >
            Videos
            <span
              id="videoTabCount"
              style={{
                fontSize: '0.6rem',
                color: 'var(--text3)',
                marginLeft: '0.35rem',
              }}
            >
              {videoCount}
            </span>
          </button>
          <button
            className={'page-tab' + (tab === 'playlists' ? ' active' : '')}
            id="tabPlaylists"
            onClick={() => setTab('playlists')}
          >
            Playlists
            <span
              id="playlistTabCount"
              style={{
                fontSize: '0.6rem',
                color: 'var(--text3)',
                marginLeft: '0.35rem',
              }}
            >
              {playlistCount}
            </span>
          </button>
          <div className="manager-tab-spacer"></div>
          <div className="manager-action-row">
            <button
              className="create-pkg-btn"
              onClick={() => videoOverlay.current?.openCreate()}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" />
              </svg>
              Create video…
            </button>
            <button
              className="create-playlist-btn"
              onClick={() => playlistOverlay.current?.openCreate()}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <polyline points="3 6 4 7 6 5" />
                <polyline points="3 12 4 13 6 11" />
                <polyline points="3 18 4 19 6 17" />
              </svg>
              Create playlist…
            </button>
            <button
              className="create-export-btn"
              onClick={() => exportOverlay.current?.open()}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                <line x1="12" y1="22.08" x2="12" y2="12" />
              </svg>
              Create package…
            </button>
            <button
              className="create-export-btn"
              onClick={() => ossmOverlay.current?.open()}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
              Export to OSSM…
            </button>
            <button
              className="import-btn"
              onClick={() => fileInputRef.current?.click()}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Import .zip
            </button>
            <button className="refresh-btn" onClick={() => void loadAll()}>
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              Refresh
            </button>
          </div>
        </div>

        <div
          className={'manager-panel' + (tab === 'videos' ? ' active' : '')}
          id="panelVideos"
        >
          <ContentList
            listId="videoList"
            type="video"
            rows={videoRows}
            error={videoError}
            emptyMessage="No videos registered in manifest"
            errorMessage="Failed to load videos"
            highlightIds={videoHighlight}
            query={search}
            onReorder={reorderVideos}
            onDelete={(id) => confirmDelete('video', id)}
            onOpen={(id, displayName) =>
              videoOverlay.current?.openEdit(id, displayName)
            }
          />
        </div>
        <div
          className={'manager-panel' + (tab === 'playlists' ? ' active' : '')}
          id="panelPlaylists"
        >
          <ContentList
            listId="playlistList"
            type="playlist"
            rows={playlistRows}
            error={playlistError}
            emptyMessage="No playlists registered in manifest"
            errorMessage="Failed to load playlists"
            highlightIds={playlistHighlight}
            query={search}
            onReorder={reorderPlaylists}
            onDelete={(id) => confirmDelete('playlist', id)}
            onOpen={(id, displayName) =>
              playlistOverlay.current?.openEdit(id, displayName)
            }
          />
        </div>
      </div>

      <CreateVideoOverlay
        api={videoOverlay}
        showToast={showToast}
        reloadVideos={loadVideos}
      />

      <CreateExportOverlay api={exportOverlay} showToast={showToast} />

      <OssmExportOverlay api={ossmOverlay} showToast={showToast} />

      <CreatePlaylistOverlay
        api={playlistOverlay}
        showToast={showToast}
        reloadPlaylists={loadPlaylists}
        setTab={setTab}
      />
    </>
  )
}
