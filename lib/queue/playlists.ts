'use client'

/**
 * Writing the queue (or one video) into real playlists, through the same
 * manager endpoints the manager's playlist editor uses, so duration tallies and
 * the manifest stay in step.
 */

import {
  fetchMeta,
  fetchPlaylists,
  MANAGER_API,
  titleToFolderId,
  type PlaylistMeta,
  type PlaylistVideoEntry,
} from '@/lib/manager-client'

export type PlaylistChoice = { id: string; title: string }

export async function listPlaylistChoices(): Promise<PlaylistChoice[]> {
  const all = await fetchPlaylists()
  return all.map((p) => ({ id: p._id, title: p.title || p._id }))
}

const entryId = (e: PlaylistVideoEntry) => (typeof e === 'string' ? e : e.id || e.videoId || '')

/** Playlists hold each video once (the manager's pool enforces it), so repeats fold. */
function uniqueFolders(folders: string[]): string[] {
  return [...new Set(folders)]
}

async function post(url: string, meta: Record<string, unknown>, fields: Record<string, string> = {}) {
  const fd = new FormData()
  fd.append('meta', JSON.stringify(meta))
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  const res = await fetch(url, { method: 'POST', body: fd, cache: 'no-store' })
  const result = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  if (result.error) throw new Error(result.error)
  return result
}

/** Returns false when the playlist already had the video. */
export async function addToPlaylist(playlistId: string, folder: string): Promise<boolean> {
  const meta = await fetchMeta<PlaylistMeta>('playlists', playlistId)
  const videos = meta.videos ?? []
  if (videos.some((e) => entryId(e) === folder)) return false
  const { _id, _errors, _warnings, ...rest } = meta
  void _id
  void _errors
  void _warnings
  await post(`${MANAGER_API}/playlists/${encodeURIComponent(playlistId)}/update`, {
    ...rest,
    videos: [...videos, folder],
  })
  return true
}

/** Creates a playlist from the queue; returns its folder id. */
export async function saveQueueAsPlaylist(title: string, folders: string[]): Promise<string> {
  const folderId = titleToFolderId(title)
  if (!folderId) throw new Error('Give the playlist a name with some letters or numbers in it.')
  const result = await post(
    `${MANAGER_API}/playlists/create`,
    { title: title.trim(), videos: uniqueFolders(folders) },
    { folderId },
  )
  return result.created || folderId
}
