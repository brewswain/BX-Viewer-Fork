'use client'

import { useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react'
import {
  MANAGER_API,
  bxFilesOf,
  errMessage,
  fetchMeta,
  fetchVideos,
  mediaUrl,
  titleToFolderId,
  type BxFileRef,
  type PlaylistMeta,
  type VideoMeta,
} from '@/lib/manager-client'
import PkgDropZone, {
  clearZone,
  emptyZone,
  fillZone,
  replaceHint,
  type ZoneState,
} from './PkgDropZone'
import type { ToastData } from './Toast'

export type PlaylistOverlayApi = {
  openCreate: () => void
  openEdit: (id: string, displayName: string) => void
  close: () => void
}

type SelectedVideo = {
  id: string
  title: string
  bxFiles: BxFileRef[]
  selectedBx: string | null
}

type Props = {
  api: RefObject<PlaylistOverlayApi | null>
  showToast: (
    type: ToastData['type'],
    title: string,
    body: ToastData['body'],
  ) => void
  reloadPlaylists: (highlightIds?: string[]) => Promise<void>
  setTab: (tab: 'videos' | 'playlists') => void
}

const THUMB_HINT = 'jpg, png, webp · click to browse'

function autoResize(ta: HTMLTextAreaElement | null) {
  if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = ta.scrollHeight + 2 + 'px'
}

export default function CreatePlaylistOverlay({
  api,
  showToast,
  reloadPlaylists,
  setTab,
}: Props) {
  const [open, setOpen] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)

  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [folderId, setFolderId] = useState('')
  const [folderIdManual, setFolderIdManual] = useState(false)
  const [folderIdBadge, setFolderIdBadge] = useState('auto-generated · editable')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')

  const [thumbFile, setThumbFile] = useState<File | null>(null)
  const [existingThumb, setExistingThumb] = useState<string | null>(null)
  const [thumbZone, setThumbZone] = useState<ZoneState>(() => emptyZone(THUMB_HINT))

  const [allVideos, setAllVideos] = useState<VideoMeta[]>([])
  const [poolLoading, setPoolLoading] = useState(false)
  const [poolFailed, setPoolFailed] = useState(false)
  const [videoSearch, setVideoSearch] = useState('')
  const [selected, setSelected] = useState<SelectedVideo[]>([])

  const [error, setError] = useState('')
  const [progressActive, setProgressActive] = useState(false)
  const [progressText, setProgressText] = useState('Creating…')
  const [submitDisabled, setSubmitDisabled] = useState(false)
  const [titleError, setTitleError] = useState(false)
  const [folderIdError, setFolderIdError] = useState(false)

  const [dragSrcIdx, setDragSrcIdx] = useState<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [draggableIdx, setDraggableIdx] = useState<number | null>(null)

  const titleRef = useRef<HTMLInputElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    autoResize(descRef.current)
  }, [description])

  function focusTitleSoon() {
    requestAnimationFrame(() => titleRef.current?.focus())
  }

  function resetPlaylist() {
    setEditMode(false)
    setEditId(null)
    setThumbFile(null)
    setExistingThumb(null)
    setSelected([])
    setFolderIdManual(false)
    setTags([])

    setTitle('')
    setAuthor('')
    setFolderId('')
    setDescription('')
    setVideoSearch('')
    setTagInput('')
    setError('')
    setProgressActive(false)
    setSubmitDisabled(false)
    setTitleError(false)
    setFolderIdError(false)
    // clearZone (not emptyZone) — see the note in CreateVideoOverlay: the
    // original setDropZoneEmpty() never restored the label/hint text.
    setThumbZone(clearZone)
  }

  async function loadPlVideoPool(): Promise<VideoMeta[]> {
    setPoolLoading(true)
    setPoolFailed(false)
    try {
      const data = await fetchVideos()
      const list = Array.isArray(data) ? data : []
      setAllVideos(list)
      setPoolLoading(false)
      return list
    } catch {
      setPoolLoading(false)
      setPoolFailed(true)
      return []
    }
  }

  function openCreatePlaylist() {
    resetPlaylist()
    setFolderIdBadge('auto-generated · editable')
    setOpen(true)
    void loadPlVideoPool()
    focusTitleSoon()
  }

  async function openEditPlaylist(id: string) {
    resetPlaylist()
    setEditMode(true)
    setEditId(id)

    setFolderIdBadge('editable · renaming moves folder')
    setFolderId(id)
    setOpen(true)
    setError('Loading…')
    setSubmitDisabled(true)

    const pool = await loadPlVideoPool()

    try {
      const meta = await fetchMeta<PlaylistMeta>('playlists', id)

      setTitle(meta.title || '')
      const rawDesc = meta.description
      setDescription(Array.isArray(rawDesc) ? rawDesc.join('\n') : rawDesc || '')
      setAuthor(meta.author || '')
      setTags(Array.isArray(meta.tags) ? [...meta.tags] : [])

      if (meta.thumbnail) {
        const name = meta.thumbnail
        setExistingThumb(name)
        setThumbZone((z) =>
          replaceHint(fillZone(z, name, mediaUrl('playlists', id, name))),
        )
      }

      const next: SelectedVideo[] = []
      for (const entry of meta.videos || []) {
        const videoId =
          typeof entry === 'string' ? entry : entry.id || entry.videoId || ''
        const bxOverride = typeof entry === 'string' ? null : entry.bxFile || null
        const videoMeta = pool.find((v) => v._folder === videoId)
        if (videoMeta) {
          const bxFiles = bxFilesOf(videoMeta)
          const selectedBx = bxOverride || (bxFiles[0] ? bxFiles[0].file : null)
          next.push({
            id: videoMeta._folder,
            title: videoMeta.title || videoMeta._folder,
            bxFiles,
            selectedBx: selectedBx || (bxFiles[0] ? bxFiles[0].file : null),
          })
        }
      }
      setSelected(next)

      setError('')
      setSubmitDisabled(false)
      focusTitleSoon()
    } catch (e) {
      setError(`Failed to load: ${errMessage(e)}`)
    }
  }

  function closeCreatePlaylist() {
    setOpen(false)
    setEditMode(false)
    setEditId(null)
  }

  useImperativeHandle(api, () => ({
    openCreate: openCreatePlaylist,
    openEdit: (id: string) => {
      void openEditPlaylist(id)
    },
    close: closeCreatePlaylist,
  }))

  // ── Thumbnail ─────────────────────────────────────────────────────────────

  function setPlThumb(f: File) {
    setThumbFile(f)
    const previewUrl = URL.createObjectURL(f)
    setThumbZone((z) => fillZone(z, f.name, previewUrl))
  }

  function clearPlThumbFile() {
    setThumbFile(null)
    setExistingThumb(null)
    setThumbZone(clearZone)
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  function addToSelected(videoMeta: VideoMeta, selectedBxFile: string | null) {
    const bxFiles = bxFilesOf(videoMeta)
    setSelected((prev) => [
      ...prev,
      {
        id: videoMeta._folder,
        title: videoMeta.title || videoMeta._folder,
        bxFiles,
        selectedBx: selectedBxFile || (bxFiles[0] ? bxFiles[0].file : null),
      },
    ])
  }

  function removeSelected(idx: number) {
    setSelected((prev) => prev.filter((_, i) => i !== idx))
  }

  function changeBx(idx: number, file: string) {
    setSelected((prev) =>
      prev.map((v, i) => (i === idx ? { ...v, selectedBx: file } : v)),
    )
  }

  // ── Tags ──────────────────────────────────────────────────────────────────

  function addTag(tag: string) {
    const t = tag.trim()
    if (!t) return
    setTags((prev) => (prev.includes(t) ? prev : [...prev, t]))
  }

  function removeTag(tag: string) {
    setTags((prev) => prev.filter((t) => t !== tag))
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async function submitCreatePlaylist() {
    setError('')

    const titleValue = title.trim()
    const folderIdValue = folderId.trim()

    let hasError = false
    let nextError = ''
    setTitleError(!titleValue)
    if (!titleValue) hasError = true
    setFolderIdError(!folderIdValue)
    if (!folderIdValue) hasError = true
    if (selected.length === 0) {
      nextError = 'Add at least one video to the playlist.'
      hasError = true
    }
    if (hasError) {
      setError(nextError || 'Please fill in all required fields.')
      return
    }

    const descRaw = description.trim()
    const descLines = descRaw ? descRaw.split('\n').map((l) => l.trimEnd()) : []
    const authorValue = author.trim()
    const meta: Record<string, unknown> = {
      title: titleValue,
      videos: selected.map((v) => {
        const defaultBx = v.bxFiles[0] ? v.bxFiles[0].file : null
        if (v.bxFiles.length > 1 && v.selectedBx && v.selectedBx !== defaultBx) {
          return { id: v.id, bxFile: v.selectedBx }
        }
        return v.id
      }),
    }
    if (authorValue) meta.author = authorValue
    if (descLines.length > 1) meta.description = descLines
    else if (descLines.length === 1) meta.description = descLines[0]
    if (tags.length > 0) meta.tags = [...tags]

    const fd = new FormData()
    fd.append('meta', JSON.stringify(meta))

    if (editMode) {
      fd.append('newFolderId', folderIdValue)
      if (thumbFile) {
        fd.append('thumbnail', thumbFile, thumbFile.name)
      } else if (existingThumb) {
        meta.thumbnail = existingThumb
        fd.set('meta', JSON.stringify(meta))
      }
    } else {
      fd.append('folderId', folderIdValue)
      if (thumbFile) fd.append('thumbnail', thumbFile, thumbFile.name)
    }

    setSubmitDisabled(true)
    setProgressActive(true)
    setProgressText(editMode ? 'Saving…' : 'Creating…')

    try {
      const url = editMode
        ? `${MANAGER_API}/playlists/${encodeURIComponent(editId as string)}/update`
        : `${MANAGER_API}/playlists/create`
      const res = await fetch(url, { method: 'POST', body: fd, cache: 'no-store' })
      const result = await res.json()
      if (result.error) throw new Error(result.error)

      closeCreatePlaylist()
      // `editMode`/`editId` are read from the closure, so closeCreatePlaylist()
      // resetting them can't clobber the branch — manager.html used module-level
      // vars and always fell through to the "created" toast when saving an edit.
      if (editMode) {
        const renamed = result.renamed ? ` (renamed to "${folderIdValue}")` : ''
        showToast('success', 'Playlist updated', `"${editId}" saved${renamed}.`)
      } else {
        showToast('success', 'Playlist created!', `"${folderIdValue}" has been added.`)
      }
      await reloadPlaylists(editMode ? [] : [result.created || folderIdValue])
      setTab('playlists')
    } catch (e) {
      setProgressActive(false)
      setSubmitDisabled(false)
      setError(`Error: ${errMessage(e)}`)
    }
  }

  // ── Derived pool ──────────────────────────────────────────────────────────

  const search = videoSearch.toLowerCase()
  const selectedIds = new Set(selected.map((v) => v.id))
  const filteredPool = allVideos.filter(
    (v) => !search || (v.title || v._folder).toLowerCase().includes(search),
  )

  return (
    <div
      id="createPlaylistOverlay"
      className={open ? 'active' : undefined}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeCreatePlaylist()
      }}
      onDragOver={(e) => e.stopPropagation()}
      onDragEnter={(e) => e.stopPropagation()}
      onDrop={(e) => e.stopPropagation()}
    >
      <div className="create-pl-panel">
        <div className="create-pl-header">
          <div className="create-pl-header-icon">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <polyline points="3 6 4 7 6 5" />
              <polyline points="3 12 4 13 6 11" />
              <polyline points="3 18 4 19 6 17" />
            </svg>
          </div>
          <div className="create-pl-header-text">
            <div className="create-pl-title" id="plPanelTitle">
              {editMode ? 'Edit Playlist' : 'Create Playlist'}
            </div>
            <div className="create-pl-subtitle" id="plPanelSubtitle">
              {editMode
                ? `playlists/${editId}/meta.json`
                : 'Build a new playlist from your videos'}
            </div>
          </div>
          <button className="create-pl-close" onClick={closeCreatePlaylist}>
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

        <div className="create-pl-body">
          {/* Left column: identity + thumbnail + description */}
          <div className="pl-left-col">
            <div>
              <div className="pkg-section-title">Playlist Identity</div>
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
              >
                <div className="pkg-field">
                  <label className="pkg-label">Playlist Title</label>
                  <input
                    ref={titleRef}
                    className={'pkg-input' + (titleError ? ' error' : '')}
                    id="plTitle"
                    type="text"
                    placeholder="My Playlist"
                    autoComplete="off"
                    value={title}
                    onChange={(e) => {
                      const value = e.target.value
                      setTitle(value)
                      if (editMode) return
                      if (!folderIdManual) setFolderId(titleToFolderId(value))
                    }}
                  />
                </div>
                <div className="pkg-field">
                  <label className="pkg-label">
                    Author <span className="optional-badge">optional</span>
                  </label>
                  <input
                    className="pkg-input"
                    id="plAuthor"
                    type="text"
                    placeholder="Author name"
                    autoComplete="off"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                  />
                </div>
                <div className="pkg-field">
                  <label className="pkg-label">
                    Folder ID{' '}
                    <span className="optional-badge" id="plFolderIdBadge">
                      {folderIdBadge}
                    </span>
                  </label>
                  <input
                    className={'pkg-input' + (folderIdError ? ' error' : '')}
                    id="plFolderId"
                    type="text"
                    placeholder="my-playlist"
                    autoComplete="off"
                    value={folderId}
                    onChange={(e) => {
                      setFolderIdManual(true)
                      setFolderId(e.target.value)
                    }}
                  />
                  <div className="pkg-folder-preview" id="plFolderPreview">
                    playlists/
                    <span id="plFolderPreviewId">{folderId || '…'}</span>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <div className="pkg-section-title">
                Thumbnail{' '}
                <span
                  style={{
                    fontSize: '0.6rem',
                    textTransform: 'none',
                    letterSpacing: 0,
                    opacity: 0.6,
                  }}
                >
                  optional
                </span>
              </div>
              <PkgDropZone
                zoneId="plThumbDropZone"
                inputId="plThumbFileInput"
                accept=".jpg,.jpeg,.png,.webp,.gif"
                labelId="plThumbDropLabel"
                labelText="Drop thumbnail here"
                hintId="plThumbDropHint"
                filenameId="plThumbDropFilename"
                clearId="plThumbDropClear"
                previewId="plThumbDropPreview"
                state={thumbZone}
                onPick={setPlThumb}
                onClear={clearPlThumbFile}
                icon={
                  <svg
                    width="28"
                    height="28"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                }
              />
            </div>

            <div className="pkg-field">
              <div className="pkg-section-title">
                Description{' '}
                <span
                  style={{
                    fontSize: '0.6rem',
                    textTransform: 'none',
                    letterSpacing: 0,
                    opacity: 0.6,
                  }}
                >
                  optional · supports markdown links
                </span>
              </div>
              <textarea
                ref={descRef}
                className="pkg-textarea"
                id="plDescription"
                placeholder={'Write a description…\nUse [text](url) for links.'}
                style={{ minHeight: '80px' }}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value)
                  autoResize(e.currentTarget)
                }}
              ></textarea>
            </div>

            <div className="pkg-field">
              <div className="pkg-section-title">
                Tags{' '}
                <span
                  style={{
                    fontSize: '0.6rem',
                    textTransform: 'none',
                    letterSpacing: 0,
                    opacity: 0.6,
                  }}
                >
                  optional · press Enter to add
                </span>
              </div>
              <div
                className="pkg-tag-box"
                id="plTagBox"
                onClick={() => tagInputRef.current?.focus()}
              >
                {tags.map((tag) => (
                  <span className="pkg-tag-chip" key={tag}>
                    {tag}
                    <button onClick={() => removeTag(tag)}>✕</button>
                  </span>
                ))}
                <input
                  ref={tagInputRef}
                  className="pkg-tag-input-inner"
                  id="plTagInput"
                  type="text"
                  placeholder="Add a tag…"
                  autoComplete="off"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault()
                      const val = e.currentTarget.value.trim().replace(/,$/, '')
                      if (val) addTag(val)
                      setTagInput('')
                    } else if (
                      e.key === 'Backspace' &&
                      e.currentTarget.value === '' &&
                      tags.length > 0
                    ) {
                      removeTag(tags[tags.length - 1])
                    }
                  }}
                />
              </div>
              <div className="pkg-tag-hint">
                Type a tag and press Enter or comma to add it. Click × to remove.
              </div>
            </div>
          </div>

          {/* Right column: video selection */}
          <div className="pl-right-col">
            <div>
              <div className="pkg-section-title">
                Available Videos{' '}
                <span
                  style={{
                    fontSize: '0.6rem',
                    textTransform: 'none',
                    letterSpacing: 0,
                    opacity: 0.6,
                  }}
                  id="plPoolHint"
                >
                  click to add
                </span>
              </div>
              <input
                className="pkg-input"
                id="plVideoSearch"
                type="text"
                placeholder="Search videos…"
                autoComplete="off"
                style={{ marginBottom: '0.5rem' }}
                value={videoSearch}
                onChange={(e) => setVideoSearch(e.target.value)}
              />
              <div className="pl-video-pool" id="plVideoPool">
                {poolLoading ? (
                  <div className="pl-selected-empty">Loading…</div>
                ) : poolFailed ? (
                  <div className="pl-selected-empty" style={{ color: 'var(--red)' }}>
                    Failed to load videos
                  </div>
                ) : filteredPool.length === 0 ? (
                  <div className="pl-selected-empty">No videos found</div>
                ) : (
                  filteredPool.map((v) => {
                    const isAdded = selectedIds.has(v._folder)
                    const thumbUrl = v.thumbnail
                      ? mediaUrl('videos', v._folder, v.thumbnail)
                      : null
                    return (
                      <div
                        key={v._folder}
                        className={'pl-pool-item' + (isAdded ? ' added' : '')}
                        data-id={v._folder}
                        onClick={
                          isAdded
                            ? undefined
                            : () => {
                                const bxFiles = bxFilesOf(v)
                                addToSelected(
                                  v,
                                  bxFiles[0] ? bxFiles[0].file : null,
                                )
                              }
                        }
                      >
                        <div className="pl-pool-thumb">
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
                        <span className="pl-pool-title">
                          {v.title || v._folder}
                        </span>
                        <span className="pl-pool-sub">{v.pathCreator || ''}</span>
                      </div>
                    )
                  })
                )}
              </div>
            </div>

            <div>
              <div className="pkg-section-title" style={{ marginTop: '0.5rem' }}>
                Selected Videos
                <span
                  id="plSelCount"
                  style={{
                    fontSize: '0.6rem',
                    textTransform: 'none',
                    letterSpacing: 0,
                    color: 'var(--text3)',
                    marginLeft: '0.35rem',
                  }}
                >
                  {selected.length ? `(${selected.length})` : ''}
                </span>
              </div>
              <div className="pl-selected-list" id="plSelectedList">
                {selected.length === 0 ? (
                  <div className="pl-selected-empty" id="plSelectedEmpty">
                    No videos added yet — click a video above
                  </div>
                ) : (
                  selected.map((v, i) => (
                    <div
                      key={`${v.id}-${i}`}
                      className={
                        'pl-sel-item' +
                        (dragSrcIdx === i ? ' dragging' : '') +
                        (dragOverIdx === i ? ' drag-over' : '')
                      }
                      data-idx={i}
                      draggable={draggableIdx === i}
                      onDragStart={(e) => {
                        setDragSrcIdx(i)
                        e.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragEnd={() => {
                        setDraggableIdx(null)
                        setDragSrcIdx(null)
                        setDragOverIdx(null)
                      }}
                      onDragOver={(e) => {
                        if (dragSrcIdx === null || dragSrcIdx === i) return
                        e.preventDefault()
                        setDragOverIdx(i)
                      }}
                      onDragLeave={() =>
                        setDragOverIdx((prev) => (prev === i ? null : prev))
                      }
                      onDrop={(e) => {
                        e.preventDefault()
                        setDragOverIdx(null)
                        if (dragSrcIdx === null || dragSrcIdx === i) return
                        const from = dragSrcIdx
                        setSelected((prev) => {
                          const next = prev.slice()
                          const [moved] = next.splice(from, 1)
                          next.splice(i, 0, moved)
                          return next
                        })
                      }}
                    >
                      <div
                        className="pl-sel-drag"
                        title="Drag to reorder"
                        onMouseDown={() => setDraggableIdx(i)}
                        onMouseUp={() => setDraggableIdx(null)}
                      >
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <circle cx="9" cy="5" r="1" fill="currentColor" />
                          <circle cx="15" cy="5" r="1" fill="currentColor" />
                          <circle cx="9" cy="12" r="1" fill="currentColor" />
                          <circle cx="15" cy="12" r="1" fill="currentColor" />
                          <circle cx="9" cy="19" r="1" fill="currentColor" />
                          <circle cx="15" cy="19" r="1" fill="currentColor" />
                        </svg>
                      </div>
                      <span className="pl-sel-num">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <span className="pl-sel-title">{v.title}</span>
                      {v.bxFiles.length > 1 ? (
                        <div className="pl-sel-bx">
                          <select
                            data-idx={i}
                            value={v.selectedBx ?? ''}
                            onChange={(e) => changeBx(i, e.target.value)}
                          >
                            {v.bxFiles.map((b) => (
                              <option key={b.file} value={b.file}>
                                {b.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : null}
                      <button
                        className="pl-sel-remove"
                        onClick={() => removeSelected(i)}
                        title="Remove"
                      >
                        <svg
                          width="10"
                          height="10"
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
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="create-pl-footer">
          <div
            className={'create-pl-progress' + (progressActive ? ' active' : '')}
            id="createPlProgress"
          >
            <div className="create-pl-spinner"></div>
            <span id="createPlProgressText">{progressText}</span>
          </div>
          <div className="create-pl-error" id="createPlError">
            {error}
          </div>
          <button className="create-pl-cancel-btn" onClick={closeCreatePlaylist}>
            Cancel
          </button>
          <button
            className="create-pl-submit-btn"
            id="createPlSubmitBtn"
            disabled={submitDisabled}
            onClick={submitCreatePlaylist}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
            </svg>
            <span id="createPlSubmitLabel">
              {editMode ? 'Save Changes' : 'Create Playlist!'}
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
