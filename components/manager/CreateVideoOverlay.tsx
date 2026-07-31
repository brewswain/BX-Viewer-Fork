'use client'

import { useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react'
import {
  MANAGER_API,
  bxFilesOf,
  errMessage,
  fetchMeta,
  mediaUrl,
  titleToFolderId,
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

export type VideoOverlayApi = {
  openCreate: () => void
  openEdit: (id: string, displayName: string) => void
}

type BxEntry = {
  file: File | null
  existingFile: string | null
  label: string
  parsedFonts?: string[]
}

type FontEntry = { file: File | null; existingFile: string | null }

type Props = {
  api: RefObject<VideoOverlayApi | null>
  showToast: (
    type: ToastData['type'],
    title: string,
    body: ToastData['body'],
  ) => void
  reloadVideos: (highlightIds?: string[]) => Promise<void>
}

const VIDEO_HINT = 'mp4, webm, mkv, mov · click to browse'
const THUMB_HINT = 'jpg, png, webp · click to browse'

const VIDEO_TYPE_OPTIONS = ['BounceX', 'Dildo Hero', 'Other']
const DIFFICULTY_OPTIONS = [
  'Easy',
  'Medium',
  'Hard',
  'Extreme',
  'Multi-Difficulty',
]
const SONG_QUANTITY_OPTIONS = ['Single Song', 'Compilation', 'No Song']

const BUILTIN_FONTS = new Set([
  'JetBrains Mono',
  'Rajdhani',
  'Arial',
  'Georgia',
  'Impact',
  'Trebuchet MS',
  'Courier New',
  'Verdana',
  'Times New Roman',
  'sans-serif',
  'serif',
  'monospace',
])

type BxLike = {
  version?: unknown
  meta?: { version?: unknown }
  effects?: Array<{ type?: string; font?: string }>
}

function extractFontsFromBx(parsed: BxLike): string[] {
  const isV2 = parsed.version === 2 || parsed.meta?.version === 2
  const effects = isV2 && Array.isArray(parsed.effects) ? parsed.effects : []
  return effects
    .filter((ef) => ef.type === 'text' && ef.font && !BUILTIN_FONTS.has(ef.font))
    .map((ef) => ef.font as string)
}

function newBxEntry(
  index: number,
  existingFile: string | null,
  preLabel: string | null,
): BxEntry {
  const label =
    preLabel != null ? preLabel : existingFile ? '' : index === 0 ? 'Default' : ''
  return { file: null, existingFile: existingFile || null, label }
}

function autoResize(ta: HTMLTextAreaElement | null) {
  if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = ta.scrollHeight + 2 + 'px'
}

export default function CreateVideoOverlay({ api, showToast, reloadVideos }: Props) {
  const [open, setOpen] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)

  const [title, setTitle] = useState('')
  const [folderId, setFolderId] = useState('')
  const [folderIdManuallyEdited, setFolderIdManuallyEdited] = useState(false)
  const [videoCreator, setVideoCreator] = useState('')
  const [pathCreator, setPathCreator] = useState('')
  const [videoType, setVideoType] = useState('')
  const [difficulty, setDifficulty] = useState('')
  const [songQuantity, setSongQuantity] = useState('')
  const [bpm, setBpm] = useState('')
  const [offset, setOffset] = useState('')
  const [description, setDescription] = useState('')

  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set())

  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [thumbFile, setThumbFile] = useState<File | null>(null)
  const [existingVideoFile, setExistingVideoFile] = useState<string | null>(null)
  const [existingThumbFile, setExistingThumbFile] = useState<string | null>(null)
  const [durationSecs, setDurationSecs] = useState<number | null>(null)
  const [videoZone, setVideoZone] = useState<ZoneState>(() => emptyZone(VIDEO_HINT))
  const [thumbZone, setThumbZone] = useState<ZoneState>(() => emptyZone(THUMB_HINT))

  const [bxEntries, setBxEntries] = useState<(BxEntry | null)[]>([])
  const [fonts, setFonts] = useState<Map<string, FontEntry>>(new Map())

  const [error, setError] = useState('')
  const [progressActive, setProgressActive] = useState(false)
  const [progressText, setProgressText] = useState('Creating package…')
  const [submitDisabled, setSubmitDisabled] = useState(false)
  const [titleError, setTitleError] = useState(false)
  const [folderIdError, setFolderIdError] = useState(false)
  const [videoMissing, setVideoMissing] = useState(false)

  const titleRef = useRef<HTMLInputElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    autoResize(descRef.current)
  }, [description])

  // Custom fonts referenced across every live .bx entry, in discovery order.
  const neededFonts: string[] = []
  for (const entry of bxEntries) {
    if (!entry?.parsedFonts) continue
    for (const f of entry.parsedFonts) if (!neededFonts.includes(f)) neededFonts.push(f)
  }

  function focusTitleSoon() {
    requestAnimationFrame(() => titleRef.current?.focus())
  }

  function resetCreatePkg(isEdit: boolean) {
    setVideoFile(null)
    setThumbFile(null)
    setBxEntries(isEdit ? [] : [newBxEntry(0, null, null)])
    setTags([])
    setHighlighted(new Set())
    setFolderIdManuallyEdited(false)
    setDurationSecs(null)
    setEditMode(false)
    setEditId(null)
    setExistingVideoFile(null)
    setExistingThumbFile(null)
    setFonts(new Map())

    setTitle('')
    setFolderId('')
    setVideoCreator('')
    setPathCreator('')
    setVideoType('')
    setDifficulty('')
    setSongQuantity('')
    setBpm('')
    setOffset('')
    setDescription('')
    setTagInput('')

    // clearZone (not emptyZone): setDropZoneEmpty() took label/hint arguments
    // but never applied them, so a hint swapped to "Drop a new file to
    // replace…" during an edit survived into the next Create dialog.
    setVideoZone(clearZone)
    setThumbZone(clearZone)

    setError('')
    setProgressActive(false)
    setSubmitDisabled(false)
    setTitleError(false)
    setFolderIdError(false)
    setVideoMissing(false)
  }

  function openCreatePkg() {
    resetCreatePkg(false)
    setOpen(true)
    focusTitleSoon()
  }

  async function openEditVideo(id: string) {
    resetCreatePkg(true)
    setEditMode(true)
    setEditId(id)
    setFolderId(id)
    setOpen(true)
    setError('Loading…')
    setSubmitDisabled(true)

    try {
      const meta = await fetchMeta<VideoMeta>('videos', id)

      setTitle(meta.title || '')
      setFolderId(id)
      setVideoCreator(meta.videoCreator || '')
      setPathCreator(meta.pathCreator || '')
      setBpm(meta.bpm != null ? String(meta.bpm) : '')
      setOffset(meta.offset != null ? String(meta.offset) : '')

      const rawDesc = meta.description
      setDescription(
        Array.isArray(rawDesc) ? rawDesc.join('\n') : rawDesc || '',
      )

      if (meta.videoFile) {
        const name = meta.videoFile
        setExistingVideoFile(name)
        setVideoZone((z) => replaceHint(fillZone(z, name)))
      }

      if (meta.thumbnail) {
        const name = meta.thumbnail
        setExistingThumbFile(name)
        setThumbZone((z) =>
          replaceHint(fillZone(z, name, mediaUrl('videos', id, name))),
        )
      }

      // Category dropdowns are stored as reserved tags — pull them back out.
      const remainingTags = [...(meta.tags || [])]
      const trySetSelect = (opts: string[], options: string[]): string => {
        for (const opt of opts) {
          const idx = remainingTags.findIndex((t) => t.toLowerCase() === opt)
          if (idx !== -1) {
            let value = ''
            for (const o of options) {
              if (o.toLowerCase() === opt) {
                value = o
                break
              }
            }
            remainingTags.splice(idx, 1)
            return value
          }
        }
        return ''
      }
      setVideoType(
        trySetSelect(['bouncex', 'dildo hero', 'other'], VIDEO_TYPE_OPTIONS),
      )
      setDifficulty(
        trySetSelect(
          ['easy', 'medium', 'hard', 'extreme', 'multi-difficulty'],
          DIFFICULTY_OPTIONS,
        ),
      )
      setSongQuantity(
        trySetSelect(
          ['single song', 'compilation', 'no song'],
          SONG_QUANTITY_OPTIONS,
        ),
      )
      ;(meta.highlightedTags || []).forEach((t) => {
        if (!remainingTags.includes(t)) remainingTags.push(t)
      })
      setTags(remainingTags)
      const hl = new Set<string>()
      if (meta.highlightedTags) {
        meta.highlightedTags.forEach((t) => {
          if (remainingTags.includes(t)) hl.add(t)
        })
      }
      setHighlighted(hl)

      const bxFiles = bxFilesOf(meta)
      const entries: (BxEntry | null)[] = []
      if (bxFiles.length > 0) {
        bxFiles.forEach((bx) =>
          entries.push(newBxEntry(entries.length, bx.file, bx.label || 'Default')),
        )
      } else {
        entries.push(newBxEntry(0, null, null))
      }
      setBxEntries(entries)

      // Fetch the on-disk .bx files to discover any custom font references.
      const parsedPerEntry = await Promise.all(
        bxFiles.map(async (bx) => {
          try {
            const r = await fetch(mediaUrl('videos', id, bx.file), {
              cache: 'no-store',
            })
            if (!r.ok) return null
            return extractFontsFromBx(await r.json())
          } catch {
            return null
          }
        }),
      )
      setBxEntries((prev) =>
        prev.map((e, i) =>
          e && parsedPerEntry[i] ? { ...e, parsedFonts: parsedPerEntry[i]! } : e,
        ),
      )

      const nextFonts = new Map<string, FontEntry>()
      for (const fontFile of meta.fonts || []) {
        const name = fontFile.replace(/\.(ttf|otf|woff2?)$/i, '')
        nextFonts.set(name, { file: null, existingFile: fontFile })
      }
      setFonts(nextFonts)

      setError('')
      setSubmitDisabled(false)
      focusTitleSoon()
    } catch (e) {
      setError(`Failed to load: ${errMessage(e)}`)
    }
  }

  function closeCreatePkg() {
    setOpen(false)
    setEditMode(false)
    setEditId(null)
  }

  useImperativeHandle(api, () => ({
    openCreate: openCreatePkg,
    openEdit: (id: string) => {
      void openEditVideo(id)
    },
  }))

  // ── Video / thumbnail files ───────────────────────────────────────────────

  function setPkgVideoFile(f: File) {
    setVideoFile(f)
    setDurationSecs(null)
    setVideoZone((z) => fillZone(z, f.name))
    setVideoMissing(false)

    // Probe duration from the local file — free since it's already in memory
    const url = URL.createObjectURL(f)
    const probe = document.createElement('video')
    probe.preload = 'metadata'
    probe.muted = true
    probe.addEventListener(
      'loadedmetadata',
      () => {
        if (probe.duration && isFinite(probe.duration)) {
          setDurationSecs(probe.duration)
          const mm = String(Math.floor(probe.duration / 60)).padStart(2, '0')
          const ss = String(Math.floor(probe.duration) % 60).padStart(2, '0')
          setVideoZone((z) => ({ ...z, filename: `${f.name}  ·  ${mm}:${ss}` }))
        }
        URL.revokeObjectURL(url)
      },
      { once: true },
    )
    probe.addEventListener('error', () => URL.revokeObjectURL(url), { once: true })
    probe.src = url
  }

  function clearVideoFile() {
    setVideoFile(null)
    setDurationSecs(null)
    setVideoZone(clearZone)
  }

  function setPkgThumbFile(f: File) {
    setThumbFile(f)
    const previewUrl = URL.createObjectURL(f)
    setThumbZone((z) => fillZone(z, f.name, previewUrl))
  }

  function clearThumbFile() {
    setThumbFile(null)
    setThumbZone(clearZone)
  }

  // ── BX entries ────────────────────────────────────────────────────────────

  function addBxEntry(existingFile: string | null = null, preLabel: string | null = null) {
    setBxEntries((prev) => [...prev, newBxEntry(prev.length, existingFile, preLabel)])
  }

  function setBxFile(idx: number, f: File) {
    setBxEntries((prev) =>
      prev.map((e, i) => (i === idx ? { ...(e as BxEntry), file: f, existingFile: null } : e)),
    )
    const reader = new FileReader()
    reader.onload = (e) => {
      let parsedFonts: string[] = []
      try {
        parsedFonts = extractFontsFromBx(JSON.parse(String(e.target?.result)))
      } catch {
        parsedFonts = []
      }
      setBxEntries((prev) =>
        prev.map((entry, i) => (i === idx && entry ? { ...entry, parsedFonts } : entry)),
      )
    }
    reader.readAsText(f)
  }

  function removeBxEntry(idx: number) {
    setBxEntries((prev) => {
      const next = prev.slice()
      next[idx] = null
      // Keep at least one row visible
      if (!next.some((e) => e !== null))
        next.push(newBxEntry(next.length, null, null))
      return next
    })
  }

  function setFontFile(name: string, file: File) {
    setFonts((prev) => {
      const next = new Map(prev)
      next.set(name, { file, existingFile: null })
      return next
    })
  }

  function clearFontEntry(name: string) {
    setFonts((prev) => {
      const next = new Map(prev)
      next.set(name, { file: null, existingFile: null })
      return next
    })
  }

  // ── Tags ──────────────────────────────────────────────────────────────────

  function addTag(tag: string) {
    const t = tag.trim()
    if (!t) return
    setTags((prev) => (prev.includes(t) ? prev : [...prev, t]))
  }

  function removeTag(tag: string) {
    setTags((prev) => prev.filter((t) => t !== tag))
    setHighlighted((prev) => {
      if (!prev.has(tag)) return prev
      const next = new Set(prev)
      next.delete(tag)
      return next
    })
  }

  function toggleHighlightTag(tag: string) {
    setHighlighted((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else {
        if (next.size >= 3) return prev
        next.add(tag)
      }
      return next
    })
  }

  // ── Meta builder ──────────────────────────────────────────────────────────

  function buildMetaObject(titleValue: string): Record<string, unknown> {
    const meta: Record<string, unknown> = { title: titleValue }
    const vc = videoCreator.trim()
    const pc = pathCreator.trim()
    const bpmVal = bpm.trim()
    const offsetVal = offset.trim()
    const desc = description.trim()

    if (vc) meta.videoCreator = vc
    if (pc) meta.pathCreator = pc
    if (bpmVal !== '') meta.bpm = parseFloat(bpmVal)
    if (offsetVal !== '') meta.offset = parseFloat(offsetVal)
    if (desc) {
      const lines = desc
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l, i, arr) => l || i < arr.length - 1)
      meta.description = lines.length > 1 ? lines : desc
    }
    if (tags.length > 0) meta.tags = [...tags]
    // Merge reserved category tags from dropdowns — prepend so they appear first
    const categoryTags = [videoType, difficulty, songQuantity]
      .filter(Boolean)
      .map((t) => t.toLowerCase())
    if (categoryTags.length > 0) {
      const existing = (meta.tags as string[] | undefined) || []
      meta.tags = [...categoryTags, ...existing.filter((t) => !categoryTags.includes(t))]
    }
    if (highlighted.size > 0) meta.highlightedTags = [...highlighted]
    return meta
  }

  function appendFonts(fd: FormData) {
    let fontIdx = 0
    for (const name of neededFonts) {
      const entry = fonts.get(name)
      if (entry?.file) {
        fd.append(`font_${fontIdx}`, entry.file, entry.file.name)
        fontIdx++
      }
    }
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async function submitCreatePkg() {
    setError('')

    if (editMode) {
      const titleValue = title.trim()
      const newFolderId = folderId.trim()

      let hasError = false
      let nextError = ''
      setTitleError(!titleValue)
      if (!titleValue) hasError = true
      setFolderIdError(!newFolderId)
      if (!newFolderId) hasError = true

      const validBx = bxEntries.filter((e) => e && (e.file || e.existingFile))
      if (validBx.length === 0) {
        nextError = 'At least one .bx file is required.'
        hasError = true
      }
      if (hasError) {
        setError(nextError || 'Please fill in all required fields.')
        return
      }

      const meta = buildMetaObject(titleValue)
      // Keep existing videoFile / thumbnail in meta so server knows current names
      if (existingVideoFile && !videoFile) meta.videoFile = existingVideoFile
      if (existingThumbFile && !thumbFile) meta.thumbnail = existingThumbFile

      const fd = new FormData()
      fd.append('newFolderId', newFolderId)
      fd.append('meta', JSON.stringify(meta))
      if (videoFile) fd.append('video', videoFile, videoFile.name)
      if (thumbFile) fd.append('thumbnail', thumbFile, thumbFile.name)

      // BX entries: send count + either bxFile_N (new) or bxExistingFile_N (keep)
      fd.append('bxCount', String(validBx.length))
      validBx.forEach((entry, i) => {
        const label = entry!.label.trim() || 'Default'
        fd.append(`bxLabel_${i}`, label)
        if (entry!.file) {
          fd.append(`bxFile_${i}`, entry!.file, entry!.file.name)
        } else {
          fd.append(`bxExistingFile_${i}`, entry!.existingFile as string)
        }
      })

      appendFonts(fd)

      setSubmitDisabled(true)
      setProgressActive(true)
      setProgressText('Saving…')

      try {
        const res = await fetch(
          `${MANAGER_API}/videos/${encodeURIComponent(editId as string)}/update`,
          { method: 'POST', body: fd, cache: 'no-store' },
        )
        const result = await res.json()
        if (result.error) throw new Error(result.error)

        closeCreatePkg()
        const renamed = result.renamed ? ` (renamed to "${newFolderId}")` : ''
        // `editId` comes from the closure, so closeCreatePkg() nulling the state
        // can't blank it. Re-reading it from state after the reset would make
        // this toast say `"null" saved.`
        showToast('success', 'Video updated', `"${editId}" saved${renamed}.`)
        await reloadVideos()
      } catch (e) {
        setProgressActive(false)
        setSubmitDisabled(false)
        setError(`Error: ${errMessage(e)}`)
      }
      return
    }

    // ── Create mode: full validation + file upload ─────────────────────
    const titleValue = title.trim()
    const newFolderId = folderId.trim()

    let hasError = false
    let nextError = ''
    setTitleError(!titleValue)
    if (!titleValue) hasError = true
    setFolderIdError(!newFolderId)
    if (!newFolderId) hasError = true
    if (!videoFile) {
      setVideoMissing(true)
      hasError = true
    }

    const validBxEntries = bxEntries.filter((e) => e && e.file)
    if (validBxEntries.length === 0) {
      nextError = 'At least one .bx file is required.'
      hasError = true
    }

    if (hasError) {
      setError(nextError || 'Please fill in all required fields.')
      return
    }

    const meta = buildMetaObject(titleValue)
    if (durationSecs !== null) meta.durationSecs = durationSecs

    const fd = new FormData()
    fd.append('folderId', newFolderId)
    fd.append('meta', JSON.stringify(meta))
    fd.append('video', videoFile as File, (videoFile as File).name)
    if (thumbFile) fd.append('thumbnail', thumbFile, thumbFile.name)

    let bxIdx = 0
    for (const entry of bxEntries) {
      if (!entry || !entry.file) continue
      fd.append(`bx_${bxIdx}`, entry.file, entry.file.name)
      fd.append(`bxLabel_${bxIdx}`, entry.label.trim() || 'Default')
      bxIdx++
    }

    appendFonts(fd)

    setSubmitDisabled(true)
    setProgressActive(true)
    setProgressText('Uploading files…')

    try {
      const res = await fetch(`${MANAGER_API}/videos/create`, {
        method: 'POST',
        body: fd,
        cache: 'no-store',
      })
      const result = await res.json()
      if (result.error) throw new Error(result.error)

      closeCreatePkg()
      showToast(
        'success',
        'Video created!',
        `"${newFolderId}" has been added to your library.`,
      )
      await reloadVideos([result.created])
    } catch (e) {
      setProgressActive(false)
      setSubmitDisabled(false)
      setError(`Error: ${errMessage(e)}`)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      id="createPkgOverlay"
      className={open ? 'active' : undefined}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeCreatePkg()
      }}
      onDragOver={(e) => e.stopPropagation()}
      onDragEnter={(e) => e.stopPropagation()}
      onDrop={(e) => e.stopPropagation()}
    >
      <div className="create-pkg-panel">
        {/* Header */}
        <div className="create-pkg-header">
          <div className="create-pkg-header-icon">
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
          <div className="create-pkg-header-text">
            <div className="create-pkg-title" id="createPkgPanelTitle">
              {editMode ? 'Edit Video' : 'Create Video'}
            </div>
            <div className="create-pkg-subtitle" id="createPkgPanelSubtitle">
              {editMode
                ? `videos/${editId}/meta.json`
                : 'Build a new video from scratch'}
            </div>
          </div>
          <button className="create-pkg-close" onClick={closeCreatePkg}>
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

        {/* Body */}
        <div className="create-pkg-body">
          {/* Files section */}
          <div id="pkgFilesSection">
            <div className="pkg-section-title">Package Files</div>
            <div className="pkg-files-grid">
              {/* Video drop zone */}
              <div>
                <div className="pkg-label" style={{ marginBottom: '0.4rem' }}>
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <polygon points="23 7 16 12 23 17 23 7" />
                    <rect x="1" y="5" width="15" height="14" rx="2" />
                  </svg>
                  Video File
                </div>
                <PkgDropZone
                  zoneId="videoDropZone"
                  inputId="videoFileInput"
                  accept=".mp4,.webm,.mkv,.mov"
                  labelId="videoDropLabel"
                  labelText="Drop video here"
                  hintId="videoDropHint"
                  filenameId="videoDropFilename"
                  clearId="videoDropClear"
                  state={videoZone}
                  requiredMissing={videoMissing}
                  onPick={setPkgVideoFile}
                  onClear={clearVideoFile}
                  icon={
                    <svg
                      width="28"
                      height="28"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <polygon points="23 7 16 12 23 17 23 7" />
                      <rect x="1" y="5" width="15" height="14" rx="2" />
                    </svg>
                  }
                />
              </div>

              {/* Thumbnail drop zone */}
              <div>
                <div className="pkg-label" style={{ marginBottom: '0.4rem' }}>
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                  Thumbnail
                  <span className="optional-badge">optional</span>
                </div>
                <PkgDropZone
                  zoneId="thumbDropZone"
                  inputId="thumbFileInput"
                  accept=".jpg,.jpeg,.png,.webp,.gif"
                  labelId="thumbDropLabel"
                  labelText="Drop thumbnail here"
                  hintId="thumbDropHint"
                  filenameId="thumbDropFilename"
                  clearId="thumbDropClear"
                  previewId="thumbDropPreview"
                  state={thumbZone}
                  onPick={setPkgThumbFile}
                  onClear={clearThumbFile}
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
            </div>
          </div>

          {/* BX Files */}
          <div id="pkgBxSection">
            <div className="pkg-section-title">BX Files</div>
            <div className="pkg-bx-list" id="bxFileList">
              {bxEntries.map((entry, idx) =>
                entry === null ? null : (
                  <BxEntryRow
                    key={idx}
                    idx={idx}
                    entry={entry}
                    onFile={(f) => setBxFile(idx, f)}
                    onLabel={(label) =>
                      setBxEntries((prev) =>
                        prev.map((e, i) => (i === idx && e ? { ...e, label } : e)),
                      )
                    }
                    onRemove={() => removeBxEntry(idx)}
                  />
                ),
              )}
            </div>
            <button
              className="pkg-add-bx-btn"
              id="pkgAddBxBtn"
              onClick={() => addBxEntry()}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add another .bx file…
            </button>
          </div>

          {/* Custom Fonts */}
          <div
            id="pkgFontSection"
            style={neededFonts.length === 0 ? { display: 'none' } : undefined}
          >
            <div className="pkg-section-title">
              Custom Fonts
              <span
                className="optional-badge"
                style={{
                  textTransform: 'none',
                  letterSpacing: 0,
                  marginLeft: '4px',
                }}
              >
                optional — falls back to JetBrains Mono
              </span>
            </div>
            <div className="pkg-bx-list" id="fontFileList">
              {neededFonts.map((name) => (
                <FontEntryRow
                  key={name}
                  name={name}
                  entry={fonts.get(name) ?? { file: null, existingFile: null }}
                  onFile={(f) => setFontFile(name, f)}
                  onClear={() => clearFontEntry(name)}
                />
              ))}
            </div>
          </div>

          {/* Identity section */}
          <div>
            <div className="pkg-section-title">Package Identity</div>
            <div className="pkg-fields-grid">
              <div className="pkg-field full-width">
                <label className="pkg-label">Video Title</label>
                <input
                  ref={titleRef}
                  className={'pkg-input' + (titleError ? ' error' : '')}
                  id="pkgTitle"
                  type="text"
                  placeholder="My New Video"
                  autoComplete="off"
                  value={title}
                  onChange={(e) => {
                    const value = e.target.value
                    setTitle(value)
                    if (editMode) return
                    if (!folderIdManuallyEdited) setFolderId(titleToFolderId(value))
                  }}
                />
              </div>
              <div className="pkg-field full-width">
                <label className="pkg-label">
                  Folder ID{' '}
                  <span className="optional-badge">auto-generated · editable</span>
                </label>
                <input
                  className={'pkg-input' + (folderIdError ? ' error' : '')}
                  id="pkgFolderId"
                  type="text"
                  placeholder="my-new-video"
                  autoComplete="off"
                  value={folderId}
                  onChange={(e) => {
                    setFolderIdManuallyEdited(true)
                    setFolderId(e.target.value)
                  }}
                />
                <div className="pkg-folder-preview" id="pkgFolderPreview">
                  videos/<span id="pkgFolderPreviewId">{folderId || '…'}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Metadata section */}
          <div>
            <div className="pkg-section-title">Metadata</div>
            <div className="pkg-fields-grid">
              <div className="pkg-field">
                <label className="pkg-label">
                  Video Creator<span className="optional-badge">optional</span>
                </label>
                <input
                  className="pkg-input"
                  id="pkgVideoCreator"
                  type="text"
                  placeholder="Creator name"
                  autoComplete="off"
                  value={videoCreator}
                  onChange={(e) => setVideoCreator(e.target.value)}
                />
              </div>
              <div className="pkg-field">
                <label className="pkg-label">
                  Path Creator<span className="optional-badge">optional</span>
                </label>
                <input
                  className="pkg-input"
                  id="pkgPathCreator"
                  type="text"
                  placeholder="Charter name"
                  autoComplete="off"
                  value={pathCreator}
                  onChange={(e) => setPathCreator(e.target.value)}
                />
              </div>
              <div className="pkg-field">
                <label className="pkg-label">
                  Video Type <span className="optional-badge">optional</span>
                </label>
                <select
                  className="pkg-select"
                  id="pkgVideoType"
                  value={videoType}
                  onChange={(e) => setVideoType(e.target.value)}
                >
                  <option value="" disabled>
                    Select type…
                  </option>
                  {VIDEO_TYPE_OPTIONS.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </div>
              <div className="pkg-field">
                <label className="pkg-label">
                  Difficulty <span className="optional-badge">optional</span>
                </label>
                <select
                  className="pkg-select"
                  id="pkgDifficulty"
                  value={difficulty}
                  onChange={(e) => setDifficulty(e.target.value)}
                >
                  <option value="" disabled>
                    Select difficulty…
                  </option>
                  {DIFFICULTY_OPTIONS.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </div>
              <div className="pkg-field full-width">
                <label className="pkg-label">
                  Song Quantity <span className="optional-badge">optional</span>
                </label>
                <select
                  className="pkg-select"
                  id="pkgSongQuantity"
                  value={songQuantity}
                  onChange={(e) => setSongQuantity(e.target.value)}
                >
                  <option value="" disabled>
                    Select song quantity…
                  </option>
                  {SONG_QUANTITY_OPTIONS.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </div>
              <div className="pkg-field">
                <label className="pkg-label">
                  BPM <span className="optional-badge">optional</span>
                </label>
                <input
                  className="pkg-input"
                  id="pkgBpm"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="120"
                  autoComplete="off"
                  value={bpm}
                  onChange={(e) => setBpm(e.target.value)}
                />
              </div>
              <div className="pkg-field">
                <label className="pkg-label">
                  Offset <span className="optional-badge">optional · ms</span>
                </label>
                <input
                  className="pkg-input"
                  id="pkgOffset"
                  type="number"
                  step="0.1"
                  placeholder="0"
                  autoComplete="off"
                  value={offset}
                  onChange={(e) => setOffset(e.target.value)}
                />
              </div>
              <div className="pkg-field full-width">
                <label className="pkg-label">
                  Description <span className="optional-badge">optional</span>
                </label>
                <textarea
                  ref={descRef}
                  className="pkg-textarea"
                  id="pkgDescription"
                  placeholder="Write a description for this video package…"
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value)
                    autoResize(e.currentTarget)
                  }}
                ></textarea>
              </div>
              <div className="pkg-field full-width">
                <label className="pkg-label">
                  Tags <span className="optional-badge">press Enter to add</span>
                </label>
                <div
                  className="pkg-tag-box"
                  id="pkgTagBox"
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
                    id="pkgTagInput"
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
              <div className="pkg-field full-width">
                <label className="pkg-label">
                  Highlighted Tags
                  <span className="optional-badge">
                    select up to 3 from your tags
                  </span>
                  <span className="pkg-highlight-count" id="pkgHlCount">
                    {tags.length === 0 ? '' : `(${highlighted.size}/3 selected)`}
                  </span>
                </label>
                <div className="pkg-highlight-pool" id="pkgHighlightPool">
                  {tags.length === 0 ? (
                    <span className="pkg-hl-empty">
                      Add tags above to highlight them
                    </span>
                  ) : (
                    tags.map((tag) => (
                      <span
                        key={tag}
                        className={
                          'pkg-hl-chip' + (highlighted.has(tag) ? ' selected' : '')
                        }
                        onClick={() => toggleHighlightTag(tag)}
                      >
                        {tag}
                      </span>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
        {/* end body */}

        {/* Footer */}
        <div className="create-pkg-footer">
          <div
            className={'create-pkg-progress' + (progressActive ? ' active' : '')}
            id="createPkgProgress"
          >
            <div className="create-pkg-spinner"></div>
            <span id="createPkgProgressText">{progressText}</span>
          </div>
          <div className="create-pkg-error" id="createPkgError">
            {error}
          </div>
          <button className="create-pkg-cancel-btn" onClick={closeCreatePkg}>
            Cancel
          </button>
          <button
            className="create-pkg-submit-btn"
            id="createPkgSubmitBtn"
            disabled={submitDisabled}
            onClick={submitCreatePkg}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              id="createPkgSubmitIcon"
            >
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            </svg>
            <span id="createPkgSubmitLabel">
              {editMode ? 'Save Changes' : 'Create Video!'}
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Sub-rows ────────────────────────────────────────────────────────────────

function BxEntryRow({
  idx,
  entry,
  onFile,
  onLabel,
  onRemove,
}: {
  idx: number
  entry: BxEntry
  onFile: (f: File) => void
  onLabel: (label: string) => void
  onRemove: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const hasFile = !!(entry.file || entry.existingFile)
  const dropLabel = entry.file
    ? entry.file.name
    : entry.existingFile
      ? entry.existingFile
      : 'Drop .bx file or click to browse'

  return (
    <div className="pkg-bx-entry" data-idx={idx}>
      <div
        ref={dropRef}
        className={
          'pkg-bx-drop' + (hasFile ? ' has-file' : '') + (dragOver ? ' drag-over' : '')
        }
        id={`bxDrop_${idx}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(true)
        }}
        onDragLeave={(e) => {
          if (!dropRef.current?.contains(e.relatedTarget as Node | null))
            setDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(false)
          const f = e.dataTransfer.files[0]
          if (f) onFile(f)
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".bx"
          id={`bxInput_${idx}`}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onFile(f)
            e.target.value = ''
          }}
        />
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={{ flexShrink: 0, color: hasFile ? 'var(--teal)' : 'var(--text3)' }}
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <span className="pkg-bx-drop-label" id={`bxLabel_${idx}`}>
          {dropLabel}
        </span>
      </div>
      <input
        className="pkg-input"
        type="text"
        id={`bxTag_${idx}`}
        placeholder="Label (e.g. Default)"
        value={entry.label}
        onChange={(e) => onLabel(e.target.value)}
      />
      <button className="pkg-remove-bx-btn" onClick={onRemove} title="Remove">
        <svg
          width="11"
          height="11"
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
  )
}

function FontEntryRow({
  name,
  entry,
  onFile,
  onClear,
}: {
  name: string
  entry: FontEntry
  onFile: (f: File) => void
  onClear: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const filename = name + '.ttf'
  const hasFile = !!(entry.file || entry.existingFile)

  return (
    <div className="pkg-bx-entry" data-font={name}>
      <div
        ref={dropRef}
        className={
          'pkg-bx-drop' + (hasFile ? ' has-file' : '') + (dragOver ? ' drag-over' : '')
        }
        id={`fontDrop_${name}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(true)
        }}
        onDragLeave={(e) => {
          if (!dropRef.current?.contains(e.relatedTarget as Node | null))
            setDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(false)
          const f = e.dataTransfer.files[0]
          if (f) onFile(f)
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".ttf,.otf,.woff,.woff2"
          id={`fontInput_${name}`}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onFile(f)
            e.target.value = ''
          }}
        />
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={{ flexShrink: 0, color: hasFile ? 'var(--teal)' : 'var(--text3)' }}
        >
          <path d="M4 7V4h16v3" />
          <path d="M9 20h6" />
          <path d="M12 4v16" />
        </svg>
        <span className="pkg-bx-drop-label" id={`fontLabel_${name}`}>
          {hasFile ? entry.existingFile || entry.file?.name || filename : filename}
        </span>
      </div>
      <div
        style={{
          flex: 1,
          fontFamily: 'var(--mono)',
          fontSize: '0.65rem',
          color: 'var(--text3)',
          paddingLeft: '2px',
        }}
      >
        {name}
      </div>
      <button
        className="pkg-remove-bx-btn"
        onClick={onClear}
        title="Remove font"
      >
        <svg
          width="11"
          height="11"
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
  )
}
