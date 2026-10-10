'use client'

/**
 * Writing the queue (or one video) into real playlists, through the same
 * manager endpoints the manager's playlist editor uses, so duration tallies and
 * the manifest stay in step.
 */

import {
  bxFilesOf,
  fetchMeta,
  fetchPlaylists,
  MANAGER_API,
  titleToFolderId,
  type PlaylistMeta,
  type PlaylistVideoEntry,
  type VideoMeta,
} from '@/lib/manager-client'
import { dedupeEntries, entryVideoId, findDuplicateEntries } from '@/lib/player/playlistEntries'

export type PlaylistChoice = { id: string; title: string }

export async function listPlaylistChoices(): Promise<PlaylistChoice[]> {
  const all = await fetchPlaylists()
  return all.map((p) => ({ id: p._id, title: p.title || p._id }))
}

/**
 * A video may repeat in a playlist only on a different path, so the queue's
 * exact repeats fold and a repeat on another path stays (see playlistEntries).
 * Unpinned rows all mean "the default", so they fold together without a lookup.
 */
function playlistEntries(items: readonly { folder: string; bxFile?: string }[]): PlaylistVideoEntry[] {
  return dedupeEntries(
    items.map((i) => (i.bxFile ? { id: i.folder, bxFile: i.bxFile } : i.folder)),
  )
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

/**
 * Adds the video on its default path. Returns false when an entry already plays
 * that path; an entry of the same video on another path does not block it.
 */
export async function addToPlaylist(playlistId: string, folder: string): Promise<boolean> {
  const meta = await fetchMeta<PlaylistMeta>('playlists', playlistId)
  const videos = meta.videos ?? []
  if (videos.some((e) => entryVideoId(e) === folder)) {
    // Only a repeat needs the default resolved, so the lookup is skipped otherwise.
    const video = await fetchMeta<VideoMeta>('videos', folder).catch(() => null)
    const first = video ? bxFilesOf(video)[0]?.file : undefined
    const defaultBx = (id: string) => (id === folder ? first : undefined)
    if (findDuplicateEntries([...videos, folder], defaultBx).length) return false
  }
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

/** Creates a playlist from the queue, keeping each row's path; returns its folder id. */
export async function saveQueueAsPlaylist(
  title: string,
  items: readonly { folder: string; bxFile?: string }[],
): Promise<string> {
  const folderId = titleToFolderId(title)
  if (!folderId) throw new Error('Give the playlist a name with some letters or numbers in it.')
  const result = await post(
    `${MANAGER_API}/playlists/create`,
    { title: title.trim(), videos: playlistEntries(items) },
    { folderId },
  )
  return result.created || folderId
}
