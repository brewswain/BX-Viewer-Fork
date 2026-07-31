import path from 'node:path'

/**
 * Repo root. Next runs with cwd = project root, which is also where
 * videos/, playlists/ and config.json live.
 */
export const ROOT = process.cwd()

export const VIDEO_BASE = path.join(ROOT, 'videos')
export const PLAYLIST_BASE = path.join(ROOT, 'playlists')
export const CONFIG_PATH = path.join(ROOT, 'config.json')

export const VIDEO_MANIFEST = path.join(VIDEO_BASE, 'manifest.json')
export const PLAYLIST_MANIFEST = path.join(PLAYLIST_BASE, 'manifest.json')

/**
 * An id is a single folder name, never a path.
 * Rejects separators and the dot entries outright rather than normalising,
 * so a traversal attempt is an error instead of a silent rewrite.
 */
export function isValidId(id: unknown): id is string {
  if (typeof id !== 'string') return false
  const trimmed = id.trim()
  if (!trimmed) return false
  if (trimmed.includes('/') || trimmed.includes('\\')) return false
  if (trimmed === '.' || trimmed === '..') return false
  if (trimmed.includes('\0')) return false
  return true
}

/** Resolve `segments` under `base`, refusing anything that escapes it. */
export function safeJoin(base: string, segments: string[]): string | null {
  if (segments.some((s) => !s || s.includes('\0'))) return null
  const target = path.resolve(base, ...segments)
  const rel = path.relative(base, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return target
}

export function videoDir(id: string): string {
  return path.join(VIDEO_BASE, id)
}

export function playlistDir(id: string): string {
  return path.join(PLAYLIST_BASE, id)
}
