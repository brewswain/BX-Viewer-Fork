'use client'

import {
  useImperativeHandle,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import {
  bxFilesOf,
  errMessage,
  fetchPlaylists,
  fetchVideos,
  mediaUrl,
  type BxFileRef,
  type PlaylistMeta,
  type PlaylistVideoEntry,
  type VideoMeta,
} from '@/lib/manager-client'
import {
  downloadOssmBundle,
  installOssmExport,
  planOssmExport,
  summarizePlan,
} from '@/lib/ossm/client'
import { slugify } from '@/lib/ossm/naming'
import type {
  OssmFileStatus,
  OssmPlan,
  OssmRequest,
  OssmTarget,
} from '@/lib/ossm/types'
import type { ToastData, ToastLine } from './Toast'

export type OssmExportOverlayApi = {
  open: () => void
  close: () => void
}

type Props = {
  api: RefObject<OssmExportOverlayApi | null>
  showToast: (
    type: ToastData['type'],
    title: string,
    body: ToastData['body'],
  ) => void
}

/** A `.bxpl` per playlist, or one paths-only export with no `.bxpl` at all. */
type BxplMode = 'per-playlist' | 'none'

type Skip = { videoId: string; reason: string }

/** One `OssmRequest` worth of work — the contract allows at most one `.bxpl`. */
type ExportGroup = {
  key: string
  label: string
  playlistTitle: string | null
  items: OssmRequest['items']
  skips: Skip[]
}

type GroupPlan = { group: ExportGroup; plan: OssmPlan | null; error: string | null }

function entryId(entry: PlaylistVideoEntry): string {
  return typeof entry === 'string' ? entry : entry.id || entry.videoId || ''
}

/** A playlist entry may pin the variant the playlist was authored against. */
function entryPin(entry: PlaylistVideoEntry): string | null {
  return typeof entry === 'string' ? null : entry.bxFile || null
}

const STATUS_COLOR: Record<OssmFileStatus, string> = {
  new: 'var(--teal)',
  identical: 'var(--text3)',
  renamed: 'var(--accent2)',
}

const STATUS_LABEL: Record<OssmFileStatus, string> = {
  new: 'new',
  identical: 'already there',
  renamed: 'renamed',
}

// The backdrop for the sibling overlays is styled through an id selector
// (`#createExportOverlay`), which can't be shared, so it lives inline here.
const BACKDROP: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1005,
  background: 'rgba(8, 9, 13, 0.92)',
  backdropFilter: 'blur(8px)',
  alignItems: 'flex-start',
  justifyContent: 'center',
  overflowY: 'auto',
  padding: '2rem 1rem',
}

const NOTE: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.65rem',
  lineHeight: 1.6,
  color: 'var(--text3)',
}

const SPAN_BOTH: CSSProperties = { gridColumn: '1 / -1', minWidth: 0 }

const VARIANT_SELECT: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.6rem',
  background: 'var(--bg3)',
  border: '1px solid var(--border)',
  borderRadius: '4px',
  color: 'var(--text2)',
  padding: '2px 4px',
  maxWidth: '150px',
  flexShrink: 0,
  cursor: 'pointer',
}

export default function OssmExportOverlay({ api, showToast }: Props) {
  const [open, setOpen] = useState(false)
  const [videos, setVideos] = useState<VideoMeta[]>([])
  const [playlists, setPlaylists] = useState<PlaylistMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [selVideos, setSelVideos] = useState<Set<string>>(new Set())
  const [selPlaylists, setSelPlaylists] = useState<Set<string>>(new Set())
  const [videoSearch, setVideoSearch] = useState('')
  const [playlistSearch, setPlaylistSearch] = useState('')
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [bxplMode, setBxplMode] = useState<BxplMode>('per-playlist')
  const [bundleName, setBundleName] = useState('ossm-sauce')
  const [stage, setStage] = useState<'select' | 'review'>('select')
  const [plans, setPlans] = useState<GroupPlan[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function loadPools() {
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

  function openOverlay() {
    setSelVideos(new Set())
    setSelPlaylists(new Set())
    setVideoSearch('')
    setPlaylistSearch('')
    setOverrides({})
    setBxplMode('per-playlist')
    setBundleName('ossm-sauce')
    setStage('select')
    setPlans(null)
    setError('')
    setBusy(false)
    setOpen(true)
    void loadPools()
  }

  function closeOverlay() {
    // A write is in flight — closing would hide the outcome, not cancel it.
    if (busy) return
    setOpen(false)
  }

  useImperativeHandle(api, () => ({
    open: openOverlay,
    close: closeOverlay,
  }))

  // ── Resolution ─────────────────────────────────────────────────────────────

  const videoById = new Map(videos.map((v) => [v._folder, v]))
  const selectedPlaylists = playlists.filter((p) => selPlaylists.has(p._id))

  // videoId → the distinct variants the selected playlists pin for it.
  const pins = new Map<string, string[]>()
  for (const p of selectedPlaylists) {
    for (const entry of p.videos || []) {
      const id = entryId(entry)
      const pin = entryPin(entry)
      if (!id || !pin) continue
      const seen = pins.get(id) || []
      if (!seen.includes(pin)) seen.push(pin)
      pins.set(id, seen)
    }
  }

  type Resolution = {
    variants: BxFileRef[]
    file: string | null
    pinned: string[]
    /** Pin dropped because the video's meta no longer lists it. */
    pinIgnored: boolean
    overridden: boolean
  }

  /**
   * Which `.bx` a video exports as. Precedence: explicit row choice, then a
   * playlist's pin, then the meta's first variant.
   *
   * Resolution is per *video*, not per (playlist, video): the same file is used
   * in every group. Two selected playlists pinning the same video differently
   * therefore collapse to one variant — rare, and the row flags it — but it
   * keeps one visible answer per row instead of a hidden per-playlist one.
   */
  function resolve(videoId: string): Resolution {
    const meta = videoById.get(videoId)
    const variants = meta ? bxFilesOf(meta) : []
    const pinned = pins.get(videoId) || []
    const has = (f: string) => variants.some((v) => v.file === f)
    if (variants.length === 0)
      return { variants, file: null, pinned, pinIgnored: false, overridden: false }

    const override = overrides[videoId]
    if (override && has(override))
      return { variants, file: override, pinned, pinIgnored: false, overridden: true }

    const pin = pinned[0]
    if (pin && !has(pin))
      // The routes validate `bxFile` against the same meta list, so honouring a
      // stale pin would just fail at install.
      return {
        variants,
        file: variants[0].file,
        pinned,
        pinIgnored: true,
        overridden: false,
      }
    if (pin)
      return { variants, file: pin, pinned, pinIgnored: false, overridden: false }

    return {
      variants,
      file: variants[0].file,
      pinned,
      pinIgnored: false,
      overridden: false,
    }
  }

  function exportable(videoId: string): boolean {
    const meta = videoById.get(videoId)
    return !!meta && bxFilesOf(meta).length > 0
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  function toggle(type: 'video' | 'playlist', id: string, item: PlaylistMeta | null) {
    if (type === 'video') {
      if (!exportable(id)) return
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
    // Pathless videos stay out of the selection and surface as skips instead.
    if (item && item.videos) {
      const ids = item.videos.map(entryId).filter((v) => v && exportable(v))
      setSelVideos((prev) => {
        const next = new Set(prev)
        ids.forEach((vid) => (wasSelected ? next.delete(vid) : next.add(vid)))
        return next
      })
    }
  }

  function selectAll(type: 'video' | 'playlist') {
    if (type === 'video') {
      const allIds = videos.map((v) => v._folder).filter(exportable)
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

  // ── Grouping ───────────────────────────────────────────────────────────────

  function makeGroup(
    key: string,
    label: string,
    playlistTitle: string | null,
    ids: string[],
  ): ExportGroup {
    const items: OssmRequest['items'] = []
    const skips: Skip[] = []
    for (const id of ids) {
      if (!videoById.has(id)) {
        skips.push({ videoId: id, reason: 'not in library' })
        continue
      }
      const { file } = resolve(id)
      if (!file) {
        skips.push({ videoId: id, reason: 'no .bx path' })
        continue
      }
      items.push({ videoId: id, bxFile: file })
    }
    return { key, label, playlistTitle, items, skips }
  }

  /** Entry ids a selected playlist contributes: the selected ones, plus the
   *  unselectable ones so they can be reported as skips. */
  function playlistIds(p: PlaylistMeta): string[] {
    return (p.videos || [])
      .map(entryId)
      .filter((id) => id && (selVideos.has(id) || !exportable(id)))
  }

  const inPlaylists = new Set<string>()
  for (const p of selectedPlaylists)
    for (const entry of p.videos || []) {
      const id = entryId(entry)
      if (id) inPlaylists.add(id)
    }
  const looseIds = videos
    .map((v) => v._folder)
    .filter((id) => selVideos.has(id) && !inPlaylists.has(id))

  function buildGroups(): ExportGroup[] {
    if (bxplMode === 'none') {
      // One request, so at most one `.bxpl` — and with several playlists in
      // play there is no single right name for it. Export paths only.
      const seen = new Set<string>()
      const ordered: string[] = []
      const push = (id: string) => {
        if (seen.has(id)) return
        seen.add(id)
        ordered.push(id)
      }
      for (const p of selectedPlaylists) playlistIds(p).forEach(push)
      looseIds.forEach(push)
      return ordered.length ? [makeGroup('__all__', 'All selected', null, ordered)] : []
    }

    const out: ExportGroup[] = []
    for (const p of selectedPlaylists) {
      const ids = playlistIds(p)
      if (!ids.length) continue
      const title = p.title || p._id
      out.push(makeGroup(p._id, title, title, ids))
    }
    if (looseIds.length)
      out.push(makeGroup('__loose__', 'Loose videos', null, looseIds))
    return out
  }

  const groups = buildGroups()
  /** Groups with nothing left to send would only ask for an empty `.bxpl`. */
  const sendable = groups.filter((g) => g.items.length > 0)
  const totalPaths = sendable.reduce((n, g) => n + g.items.length, 0)
  const bxplCount = sendable.filter((g) => g.playlistTitle).length

  const skipsById = new Map<string, Skip>()
  for (const g of groups) for (const s of g.skips) skipsById.set(s.videoId, s)
  const skips = [...skipsById.values()]

  function bundleFor(group: ExportGroup, total: number): string {
    const base = slugify(bundleName) || 'ossm-sauce'
    // Several zips in one action need distinct filenames.
    if (total <= 1) return base
    return `${base}-${slugify(group.label) || group.key}`
  }

  function requestFor(group: ExportGroup, total: number): OssmRequest {
    return {
      items: group.items,
      playlistTitle: group.playlistTitle,
      bundleName: bundleFor(group, total),
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  function plural(n: number, word: string) {
    return `${n} ${word}${n !== 1 ? 's' : ''}`
  }

  function guard(): boolean {
    if (busy) return false
    if (!sendable.length) {
      setError(
        totalPaths === 0 && (selVideos.size || selPlaylists.size)
          ? 'Nothing to export — none of the selected videos has a .bx path.'
          : 'Select at least one video or playlist.',
      )
      return false
    }
    return true
  }

  async function runDownload() {
    if (!guard()) return
    const reqs = sendable
    setBusy(true)
    setError(reqs.length > 1 ? `Preparing ${reqs.length} zips…` : 'Preparing zip…')

    const ok: string[] = []
    const bad: string[] = []
    for (const g of reqs) {
      try {
        await downloadOssmBundle(requestFor(g, reqs.length))
        ok.push(g.label)
      } catch (e) {
        bad.push(`${g.label}: ${errMessage(e)}`)
      }
    }
    setBusy(false)

    if (!bad.length) {
      setError('')
      setOpen(false)
      showToast(
        'success',
        reqs.length > 1 ? `${reqs.length} downloads started` : 'Download started',
        `${plural(totalPaths, 'path')} — extract over your OSSM Sauce folder.`,
      )
      return
    }
    setError(`${bad.length} of ${reqs.length} failed`)
    const lines: ToastLine[] = []
    if (ok.length) lines.push({ count: ok.length, label: 'downloaded', ids: ok })
    lines.push({ count: bad.length, label: 'failed', ids: bad })
    showToast('error', 'Export incomplete', lines)
  }

  /** Install is always a two-step: dry run, review, then write. */
  async function runPlan() {
    if (!guard()) return
    const reqs = sendable
    setBusy(true)
    setError('Checking the OSSM Sauce folder…')

    const results: GroupPlan[] = []
    for (const g of reqs) {
      try {
        results.push({
          group: g,
          plan: await planOssmExport(requestFor(g, reqs.length)),
          error: null,
        })
      } catch (e) {
        results.push({ group: g, plan: null, error: errMessage(e) })
      }
    }
    setPlans(results)
    setBusy(false)
    setError('')
    setStage('review')
  }

  async function runInstall() {
    if (busy || !plans) return
    const ready = plans.filter((p) => p.plan?.canInstall)
    if (!ready.length) return

    setBusy(true)
    setError('Writing…')
    const written: string[] = []
    const skipped: string[] = []
    const bxpl: string[] = []
    const bad: string[] = []
    for (const p of ready) {
      try {
        const res = await installOssmExport(requestFor(p.group, plans.length))
        written.push(...res.written)
        skipped.push(...res.skipped)
        if (res.playlist) bxpl.push(res.playlist)
      } catch (e) {
        bad.push(`${p.group.label}: ${errMessage(e)}`)
      }
    }
    setBusy(false)

    const lines: ToastLine[] = []
    if (written.length)
      lines.push({ count: written.length, label: 'paths written', ids: written })
    if (bxpl.length)
      lines.push({ count: bxpl.length, label: 'playlist files', ids: bxpl })
    if (skipped.length)
      lines.push({
        count: skipped.length,
        label: 'already there',
        ids: skipped,
        dim: true,
      })
    if (bad.length) lines.push({ count: bad.length, label: 'failed', ids: bad })
    if (!lines.length)
      lines.push({ count: 0, label: 'nothing to write', ids: [] })

    showToast(
      bad.length ? 'error' : 'success',
      bad.length ? 'Install incomplete' : 'Installed to OSSM Sauce',
      lines,
    )
    if (bad.length) setError(`${bad.length} of ${ready.length} failed`)
    else {
      setError('')
      setOpen(false)
    }
  }

  // ── Pools ──────────────────────────────────────────────────────────────────

  const vSearch = videoSearch.toLowerCase()
  const pSearch = playlistSearch.toLowerCase()
  const filteredVideos = videos.filter((item) => {
    const id = item._folder
    const t = item.title || id
    return (
      !vSearch ||
      t.toLowerCase().includes(vSearch) ||
      id.toLowerCase().includes(vSearch)
    )
  })
  const filteredPlaylists = playlists.filter((item) => {
    const id = item._id
    const t = item.title || id
    return (
      !pSearch ||
      t.toLowerCase().includes(pSearch) ||
      id.toLowerCase().includes(pSearch)
    )
  })

  function variantCell(videoId: string) {
    const { variants, file, pinned, pinIgnored, overridden } = resolve(videoId)
    if (!file)
      return (
        <span className="export-item-sub" style={{ color: 'var(--red)' }}>
          no .bx — skipped
        </span>
      )

    const conflicted = pinned.length > 1
    const note = pinIgnored
      ? 'pin missing'
      : conflicted
        ? 'pins differ'
        : overridden
          ? 'chosen'
          : pinned.length
            ? 'pinned'
            : ''

    return (
      <>
        {note ? (
          <span
            className="export-item-sub"
            style={{
              color: pinIgnored || conflicted ? 'var(--accent2)' : 'var(--text3)',
            }}
            title={
              pinIgnored
                ? `The playlist pins ${pinned[0]}, which this video's meta no longer lists.`
                : conflicted
                  ? `Selected playlists pin different variants (${pinned.join(', ')}); one is used for all of them.`
                  : overridden
                    ? 'Variant chosen here.'
                    : 'Pinned by a selected playlist.'
            }
          >
            {note}
          </span>
        ) : null}
        {variants.length > 1 ? (
          <select
            style={VARIANT_SELECT}
            value={file}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              e.stopPropagation()
              const next = e.target.value
              setOverrides((prev) => ({ ...prev, [videoId]: next }))
            }}
          >
            {variants.map((v) => (
              <option key={v.file} value={v.file}>
                {v.file}
                {v.label && v.label !== v.file ? ` — ${v.label}` : ''}
              </option>
            ))}
          </select>
        ) : (
          <span className="export-item-sub">{file}</span>
        )}
      </>
    )
  }

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
      const dead = isVideo && !exportable(id)

      return (
        <div
          key={id}
          className={'export-pool-item' + (isSelected ? ' selected' : '')}
          style={dead ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
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
          {isVideo ? variantCell(id) : null}
          {!isVideo && pl?.videos ? (
            <span className="export-item-sub">{pl.videos.length}v</span>
          ) : null}
        </div>
      )
    })
  }

  // ── Review ─────────────────────────────────────────────────────────────────

  const okPlans = (plans || []).filter((p) => p.plan)
  const badPlans = (plans || []).filter((p) => p.error)
  const canInstall = okPlans.length > 0 && okPlans.every((p) => p.plan!.canInstall)
  const target: OssmTarget | null = okPlans[0]?.plan?.target ?? null
  // `identical` files are no-ops, so they aren't part of what the button writes.
  const writeCount = okPlans.reduce(
    (n, p) => n + p.plan!.files.filter((f) => f.status !== 'identical').length,
    0,
  )

  function reviewBody() {
    return (
      <div style={{ ...SPAN_BOTH, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div>
          <div className="pkg-section-title">Target folder</div>
          <div
            style={{
              ...NOTE,
              color: target?.dir ? 'var(--text)' : 'var(--red)',
              wordBreak: 'break-all',
              marginTop: '0.4rem',
            }}
          >
            {target?.dir || 'Could not work out where OSSM Sauce is installed.'}
          </div>
          {target ? (
            <div style={NOTE}>
              resolved from {target.source}
              {target.exists ? '' : ' · nothing installed there yet — folders will be created'}
            </div>
          ) : null}
        </div>

        {!canInstall && okPlans.length ? (
          <div
            style={{
              ...NOTE,
              color: 'var(--accent2)',
              border: '1px solid rgba(232, 131, 26, 0.35)',
              borderRadius: 'var(--radius)',
              padding: '0.6rem 0.75rem',
            }}
          >
            This page is open on a different device from the one running the
            server, so installing would write into the <em>server</em> machine&apos;s
            Documents folder, not yours. Download the zip instead and extract it
            over your own OSSM Sauce folder.
          </div>
        ) : null}

        {badPlans.map((p) => (
          <div key={p.group.key} style={{ ...NOTE, color: 'var(--red)' }}>
            {p.group.label}: {p.error}
          </div>
        ))}

        {okPlans.map(({ group, plan }) => (
          <div key={group.key}>
            <div className="pkg-section-title">
              {group.label}
              <span
                style={{
                  fontSize: '0.6rem',
                  textTransform: 'none',
                  letterSpacing: 0,
                  color: 'var(--text3)',
                  marginLeft: '0.35rem',
                }}
              >
                ({summarizePlan(plan!)})
              </span>
            </div>
            <div style={{ ...NOTE, marginTop: '0.3rem' }}>
              {plan!.playlist
                ? `Playlists/${plan!.playlist.name} · ${plural(plan!.playlist.lines.length, 'line')}`
                : 'paths only — no .bxpl'}
            </div>
            <div className="export-pool" style={{ marginTop: '0.4rem' }}>
              {plan!.files.map((f) => (
                <div
                  key={f.name}
                  className="export-pool-item"
                  style={{ cursor: 'default' }}
                >
                  <span
                    className="export-item-sub"
                    style={{
                      color: STATUS_COLOR[f.status],
                      width: '5.5rem',
                      flexShrink: 0,
                    }}
                  >
                    {STATUS_LABEL[f.status]}
                  </span>
                  <span className="export-item-title">Paths/{f.name}</span>
                  <span className="export-item-sub">
                    {f.videoId}/{f.sourceFile}
                  </span>
                </div>
              ))}
              {plan!.files.length === 0 ? (
                <div className="pl-selected-empty">No files</div>
              ) : null}
            </div>
            {plan!.warnings.map((w, i) => (
              <div key={i} style={{ ...NOTE, color: 'var(--accent2)' }}>
                {w}
              </div>
            ))}
          </div>
        ))}
      </div>
    )
  }

  // ── Select stage summary ───────────────────────────────────────────────────

  function selectionSummary() {
    return (
      <div style={{ ...SPAN_BOTH, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div className="pkg-section-title">Playlist files</div>
        <label style={{ ...NOTE, display: 'flex', gap: '0.45rem', cursor: 'pointer' }}>
          <input
            type="radio"
            name="ossmBxplMode"
            checked={bxplMode === 'per-playlist'}
            onChange={() => setBxplMode('per-playlist')}
          />
          <span>
            A <code>.bxpl</code> per selected playlist
            {selPlaylists.size > 1
              ? ' — one export each, so Download gives you one zip per playlist'
              : ''}
          </span>
        </label>
        <label style={{ ...NOTE, display: 'flex', gap: '0.45rem', cursor: 'pointer' }}>
          <input
            type="radio"
            name="ossmBxplMode"
            checked={bxplMode === 'none'}
            onChange={() => setBxplMode('none')}
          />
          <span>
            Paths only — everything in one export, nothing written to{' '}
            <code>Playlists/</code>
          </span>
        </label>

        <div
          style={{
            ...NOTE,
            color: sendable.length ? 'var(--text2)' : 'var(--text3)',
          }}
        >
          {sendable.length
            ? `${plural(totalPaths, 'path')} · ${plural(bxplCount, '.bxpl file')} · ${plural(sendable.length, 'export')}`
            : selVideos.size || selPlaylists.size
              ? 'Nothing exportable — none of the selected videos has a .bx path.'
              : 'Nothing selected yet.'}
        </div>
        {skips.length ? (
          <div style={{ ...NOTE, color: 'var(--accent2)' }}>
            Skipped: {skips.map((s) => `${s.videoId} (${s.reason})`).join(', ')}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div
      id="ossmExportOverlay"
      style={{ ...BACKDROP, display: open ? 'flex' : 'none' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeOverlay()
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
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          </div>
          <div className="create-export-header-text">
            <div className="create-export-title">Export to OSSM Sauce</div>
            <div className="create-export-subtitle">
              {stage === 'review'
                ? 'Review what would be written before anything touches your Documents folder'
                : 'Copy .bx paths into Documents/OSSM Sauce, or download a zip to extract there'}
            </div>
          </div>
          <button className="create-export-close" onClick={closeOverlay}>
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
          {stage === 'review' ? (
            reviewBody()
          ) : (
            <>
              {/* Videos column */}
              <div className="export-col">
                <div className="pkg-section-title">
                  Videos
                  <span
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
                  type="text"
                  placeholder="Search videos…"
                  autoComplete="off"
                  style={{ marginBottom: '0.25rem' }}
                  value={videoSearch}
                  onChange={(e) => setVideoSearch(e.target.value)}
                />
                <div className="export-pool">{poolBody('video')}</div>
                <button className="export-sel-all" onClick={() => selectAll('video')}>
                  Select all / None
                </button>
              </div>

              {/* Playlists column */}
              <div className="export-col">
                <div className="pkg-section-title">
                  Playlists
                  <span
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
                  type="text"
                  placeholder="Search playlists…"
                  autoComplete="off"
                  style={{ marginBottom: '0.25rem' }}
                  value={playlistSearch}
                  onChange={(e) => setPlaylistSearch(e.target.value)}
                />
                <div className="export-pool">{poolBody('playlist')}</div>
                <button
                  className="export-sel-all"
                  onClick={() => selectAll('playlist')}
                >
                  Select all / None
                </button>
              </div>

              {selectionSummary()}
            </>
          )}
        </div>

        <div className="create-export-footer">
          {stage === 'review' ? (
            <>
              <div className="export-filename-wrap">
                <span
                  className="export-filename-label"
                  style={{ whiteSpace: 'normal' }}
                >
                  {canInstall
                    ? 'Nothing is overwritten — a clashing name gets a suffix instead.'
                    : 'Install unavailable — download the zip instead.'}
                </span>
              </div>
              <span className="create-export-error">{error}</span>
              <button
                className="create-export-cancel-btn"
                disabled={busy}
                onClick={() => {
                  setStage('select')
                  setError('')
                }}
              >
                Back
              </button>
              <button
                className="create-export-cancel-btn"
                style={{ color: 'var(--accent)', borderColor: 'rgba(240, 180, 41, 0.35)' }}
                disabled={busy}
                onClick={() => void runDownload()}
              >
                Download .zip
              </button>
              <button
                className="create-export-submit-btn"
                disabled={busy || !canInstall}
                onClick={() => void runInstall()}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Write {plural(writeCount, 'file')}
              </button>
            </>
          ) : (
            <>
              <div className="export-filename-wrap">
                <span className="export-filename-label">Zip name:</span>
                <input
                  className="export-filename-input"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={bundleName}
                  onChange={(e) => setBundleName(e.target.value)}
                />
                <span className="export-filename-ext">.zip</span>
              </div>
              <span className="create-export-error">{error}</span>
              <button
                className="create-export-cancel-btn"
                disabled={busy}
                onClick={closeOverlay}
              >
                Cancel
              </button>
              <button
                className="create-export-cancel-btn"
                style={{ color: 'var(--accent)', borderColor: 'rgba(240, 180, 41, 0.35)' }}
                disabled={busy || !sendable.length}
                onClick={() => void runDownload()}
              >
                Download .zip
              </button>
              <button
                className="create-export-submit-btn"
                disabled={busy || !sendable.length}
                onClick={() => void runPlan()}
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
                Install…
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
