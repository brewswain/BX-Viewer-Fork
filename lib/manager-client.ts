/**
 * Client-side helpers for the manager UI.
 *
 * The manager used to run on its own port and discovered the two base URLs at
 * runtime via `GET /manager-api/config`.  Everything now lives on one origin,
 * so both bases collapse to `''` and the API prefix moved to `/api/manager`.
 */

/** Base for manager API calls — same origin. */
export const API = ''
/** Base for static media (thumbnails, .bx files, videos) — same origin. */
export const SITE_URL = ''

export const MANAGER_API = `${API}/api/manager`

export type Section = 'videos' | 'playlists'
export type ItemType = 'video' | 'playlist'

export type BxFileRef = { label: string; file: string }

export type VideoMeta = {
  _folder: string
  _errors?: string[]
  _warnings?: string[]
  _synthesized?: boolean
  title?: string
  videoFile?: string
  thumbnail?: string
  bxFile?: string
  bxFiles?: BxFileRef[]
  fonts?: string[]
  videoCreator?: string
  pathCreator?: string
  bpm?: number
  offset?: number
  durationSecs?: number
  description?: string | string[]
  tags?: string[]
  highlightedTags?: string[]
  [key: string]: unknown
}

export type PlaylistVideoEntry =
  | string
  | { id?: string; videoId?: string; bxFile?: string | null }

export type PlaylistMeta = {
  _id: string
  _errors?: string[]
  _warnings?: string[]
  title?: string
  author?: string
  thumbnail?: string
  description?: string | string[]
  tags?: string[]
  videos?: PlaylistVideoEntry[]
  [key: string]: unknown
}

export type ImportResult = {
  added_videos: string[]
  added_playlists: string[]
  skipped: Array<{ id: string; type: string; reason: string }>
  error?: string
}

/** `meta.bxFiles`, falling back to the legacy single `meta.bxFile`. */
export function bxFilesOf(meta: {
  bxFiles?: BxFileRef[]
  bxFile?: string
}): BxFileRef[] {
  if (meta.bxFiles) return meta.bxFiles
  if (meta.bxFile) return [{ label: 'Default', file: meta.bxFile }]
  return []
}

export function sectionOf(type: ItemType): Section {
  return type === 'video' ? 'videos' : 'playlists'
}

export function titleToFolderId(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60)
}

/** URL for a file that lives inside a video/playlist folder. */
export function mediaUrl(section: Section, id: string, file: string): string {
  return `${SITE_URL}/${section}/${encodeURIComponent(id)}/${encodeURIComponent(file)}`
}

export function metaUrl(section: Section, id: string): string {
  return `${MANAGER_API}/${section}/${encodeURIComponent(id)}/meta`
}

export async function fetchVideos(): Promise<VideoMeta[]> {
  const res = await fetch(`${MANAGER_API}/videos?_t=${Date.now()}`, {
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (data && data.error) throw new Error(data.error)
  return data as VideoMeta[]
}

export async function fetchPlaylists(): Promise<PlaylistMeta[]> {
  const res = await fetch(`${MANAGER_API}/playlists`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (data && data.error) throw new Error(data.error)
  return data as PlaylistMeta[]
}

export async function fetchMeta<T>(section: Section, id: string): Promise<T> {
  const res = await fetch(metaUrl(section, id), { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
