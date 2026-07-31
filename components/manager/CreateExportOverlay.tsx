'use client'

import { useImperativeHandle, useState, type RefObject } from 'react'
import {
  MANAGER_API,
  errMessage,
  fetchPlaylists,
  fetchVideos,
  mediaUrl,
  type PlaylistMeta,
  type VideoMeta,
} from '@/lib/manager-client'
import type { ToastData } from './Toast'

export type ExportOverlayApi = {
  open: () => void
  close: () => void
}

type Props = {
  api: RefObject<ExportOverlayApi | null>
  showToast: (
    type: ToastData['type'],
    title: string,
    body: ToastData['body'],
  ) => void
}

function playlistVideoIds(item: PlaylistMeta): string[] {
  return (item.videos || []).map((v) =>
    typeof v === 'string' ? v : (v.id as string),
  )
}

export default function CreateExportOverlay({ api, showToast }: Props) {
  const [open, setOpen] = useState(false)
  const [videos, setVideos] = useState<VideoMeta[]>([])
  const [playlists, setPlaylists] = useState<PlaylistMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [selVideos, setSelVideos] = useState<Set<string>>(new Set())
  const [selPlaylists, setSelPlaylists] = useState<Set<string>>(new Set())
  const [videoSearch, setVideoSearch] = useState('')
  const [playlistSearch, setPlaylistSearch] = useState('')
  const [filename, setFilename] = useState('package')
  const [error, setError] = useState('')
  const [submitDisabled, setSubmitDisabled] = useState(false)

  async function loadExportPools() {
    setLoading(true)
    setFailed(false)
    try {
      const [vData, pData] = await Promise.all([fetchVideos(), fetchPlaylists()])
      setVideos(Array.isArray(vData) ? vData : [])
      setPlaylists(Array.isArray(pData) ? pData : [])
      setLoading(false)
    } catch {
      setLoading(false)
      setFailed(true)
    }
  }

  function openCreateExport() {
    setSelVideos(new Set())
    setSelPlaylists(new Set())
    setVideoSearch('')
    setPlaylistSearch('')
    setFilename('package')
    setError('')
    setSubmitDisabled(false)
    setOpen(true)
    void loadExportPools()
  }

  function closeCreateExport() {
    setOpen(false)
  }

  useImperativeHandle(api, () => ({
    open: openCreateExport,
    close: closeCreateExport,
  }))

  function toggle(type: 'video' | 'playlist', id: string, item: PlaylistMeta | null) {
    if (type === 'video') {
      setSelVideos((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      return
    }
    const wasSelected = selPlaylists.has(id)
    setSelPlaylists((prev) => {
      const next = new Set(prev)
      if (wasSelected) next.delete(id)
      else next.add(id)
      return next
    })
    // Selecting a playlist pulls its videos in; deselecting drops them again.
    if (item && item.videos) {
      const ids = playlistVideoIds(item)
      setSelVideos((prev) => {
        const next = new Set(prev)
        ids.forEach((vid) => (wasSelected ? next.delete(vid) : next.add(vid)))
        return next
      })
    }
  }

  function exportSelectAll(type: 'video' | 'playlist') {
    if (type === 'video') {
      const allIds = videos.map((v) => v._folder)
      setSelVideos((prev) =>
        prev.size === allIds.length ? new Set() : new Set(allIds),
      )
    } else {
      const allIds = playlists.map((p) => p._id)
      setSelPlaylists((prev) =>
        prev.size === allIds.length ? new Set() : new Set(allIds),
      )
    }
  }

  async function submitCreateExport() {
    setError('')

    if (selVideos.size === 0 && selPlaylists.size === 0) {
      setError('Select at least one video or playlist.')
      return
    }

    const name = filename.trim() || 'package'

    setSubmitDisabled(true)
    setError('Preparing download…')

    try {
      // Step 1: POST the selection → server stores it and returns a one-use token
      const res = await fetch(`${MANAGER_API}/export-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videos: [...selVideos],
          playlists: [...selPlaylists],
          filename: name,
        }),
        cache: 'no-store',
      })

      if (!res.ok) {
        const err = await res
          .json()
          .catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }

      const { token } = await res.json()

      // Step 2: navigate directly to the download URL — the browser's native
      // download manager handles it with no fetch timeout.
      window.location.href = `${MANAGER_API}/export-download?token=${token}`

      closeCreateExport()
      showToast(
        'success',
        'Download started',
        `${selVideos.size} video${selVideos.size !== 1 ? 's' : ''}, ${selPlaylists.size} playlist${selPlaylists.size !== 1 ? 's' : ''} — check your downloads.`,
      )
    } catch (e) {
      setError(`Error: ${errMessage(e)}`)
    } finally {
      setSubmitDisabled(false)
    }
  }

  const vSearch = videoSearch.toLowerCase()
  const pSearch = playlistSearch.toLowerCase()
  const filteredVideos = videos.filter((item) => {
    const id = item._folder
    const t = item.title || id
    return (
      !vSearch || t.toLowerCase().includes(vSearch) || id.toLowerCase().includes(vSearch)
    )
  })
  const filteredPlaylists = playlists.filter((item) => {
    const id = item._id
    const t = item.title || id
    return (
      !pSearch || t.toLowerCase().includes(pSearch) || id.toLowerCase().includes(pSearch)
    )
  })

  function poolBody(type: 'video' | 'playlist') {
    const isVideo = type === 'video'
    if (loading) return <div className="pl-selected-empty">Loading…</div>
    if (failed)
      return (
        <div className="pl-selected-empty" style={{ color: 'var(--red)' }}>
          Failed to load
        </div>
      )
    const filtered = isVideo ? filteredVideos : filteredPlaylists
    if (filtered.length === 0)
      return <div className="pl-selected-empty">No items found</div>

    return filtered.map((item) => {
      const id = isVideo
        ? (item as VideoMeta)._folder
        : (item as PlaylistMeta)._id
      const t = item.title || id
      const thumbUrl = item.thumbnail
        ? mediaUrl(isVideo ? 'videos' : 'playlists', id, item.thumbnail)
        : null
      const isSelected = isVideo ? selVideos.has(id) : selPlaylists.has(id)
      const pl = isVideo ? null : (item as PlaylistMeta)

      return (
        <div
          key={id}
          className={'export-pool-item' + (isSelected ? ' selected' : '')}
          onClick={() => toggle(type, id, pl)}
        >
          <svg
            className="export-check"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            {isSelected ? (
              <polyline points="20 6 9 17 4 12" />
            ) : (
              <rect x="3" y="3" width="18" height="18" rx="2" strokeWidth="1.5" />
            )}
          </svg>
          <div className="export-item-thumb">
            {thumbUrl ? (
              <img
                src={thumbUrl}
                alt=""
                onError={(e) => {
                  e.currentTarget.style.display = 'none'
                }}
              />
            ) : null}
          </div>
          <span className="export-item-title">{t}</span>
          {isVideo && (item as VideoMeta).pathCreator ? (
            <span className="export-item-sub">
              {(item as VideoMeta).pathCreator}
            </span>
          ) : null}
          {!isVideo && pl?.videos ? (
            <span className="export-item-sub">{pl.videos.length}v</span>
          ) : null}
        </div>
      )
    })
  }

  return (
    <div
      id="createExportOverlay"
      className={open ? 'active' : undefined}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeCreateExport()
      }}
      onDragOver={(e) => e.stopPropagation()}
      onDragEnter={(e) => e.stopPropagation()}
      onDrop={(e) => e.stopPropagation()}
    >
      <div className="create-export-panel">
        <div className="create-export-header">
          <div className="create-export-header-icon">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
              <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
          </div>
          <div className="create-export-header-text">
            <div className="create-export-title">Create Package</div>
            <div className="create-export-subtitle">
              Export videos and playlists as a .zip for import elsewhere
            </div>
          </div>
          <button className="create-export-close" onClick={closeCreateExport}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="create-export-body">
          {/* Videos column */}
          <div className="export-col">
            <div className="pkg-section-title">
              Videos
              <span
                id="exportVideoSelCount"
                style={{
                  fontSize: '0.6rem',
                  textTransform: 'none',
                  letterSpacing: 0,
                  color: 'var(--text3)',
                  marginLeft: '0.35rem',
                }}
              >
                {selVideos.size ? `(${selVideos.size} selected)` : ''}
              </span>
            </div>
            <input
              className="pkg-input"
              id="exportVideoSearch"
              type="text"
              placeholder="Search videos…"
              autoComplete="off"
              style={{ marginBottom: '0.25rem' }}
              value={videoSearch}
              onChange={(e) => setVideoSearch(e.target.value)}
            />
            <div className="export-pool" id="exportVideoPool">
              {poolBody('video')}
            </div>
            <button
              className="export-sel-all"
              onClick={() => exportSelectAll('video')}
            >
              Select all / None
            </button>
          </div>

          {/* Playlists column */}
          <div className="export-col">
            <div className="pkg-section-title">
              Playlists
              <span
                id="exportPlaylistSelCount"
                style={{
                  fontSize: '0.6rem',
                  textTransform: 'none',
                  letterSpacing: 0,
                  color: 'var(--text3)',
                  marginLeft: '0.35rem',
                }}
              >
                {selPlaylists.size ? `(${selPlaylists.size} selected)` : ''}
              </span>
            </div>
            <input
              className="pkg-input"
              id="exportPlaylistSearch"
              type="text"
              placeholder="Search playlists…"
              autoComplete="off"
              style={{ marginBottom: '0.25rem' }}
              value={playlistSearch}
              onChange={(e) => setPlaylistSearch(e.target.value)}
            />
            <div className="export-pool" id="exportPlaylistPool">
              {poolBody('playlist')}
            </div>
            <button
              className="export-sel-all"
              onClick={() => exportSelectAll('playlist')}
            >
              Select all / None
            </button>
          </div>
        </div>

        <div className="create-export-footer">
          <div className="export-filename-wrap">
            <span className="export-filename-label">Filename:</span>
            <input
              className="export-filename-input"
              id="exportFilename"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
            />
            <span className="export-filename-ext">.zip</span>
          </div>
          <span className="create-export-error" id="createExportError">
            {error}
          </span>
          <button
            className="create-export-cancel-btn"
            onClick={closeCreateExport}
          >
            Cancel
          </button>
          <button
            className="create-export-submit-btn"
            id="createExportSubmitBtn"
            disabled={submitDisabled}
            onClick={submitCreateExport}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download .zip
          </button>
        </div>
      </div>
    </div>
  )
}
