import path from 'node:path'
import { jsonResponse, readJson } from '@/lib/json'
import { manifestExists, readManifest } from '@/lib/manager/manifest'
import { PLAYLIST_BASE, VIDEO_BASE, isValidId } from '@/lib/paths'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The whole library in one response.
 *
 * The browse page and the watch page's suggestions both used to read the
 * manifest and then fetch one meta.json per entry, which is 72 requests for the
 * browse grid and another 71 for a five item suggestion list. The bytes were
 * never the problem: all 72 metas together are about 120 KB. The connections
 * were. Next serves HTTP/1.1, so the browser has roughly six sockets to this
 * origin, and on the watch page those fetches launch in the same pass as the
 * video load, which puts 71 metadata requests directly in front of the range
 * requests a multi-GB carrier is trying to fill its buffer with.
 *
 * Deliberately NOT cached. The walk is about 16 ms warm, and meta.json is
 * hand-edited in this library (a new reading is appended to `bxFiles` by hand),
 * so a cache keyed on the manager's write counter would go stale in exactly the
 * case that is hardest to debug. Sixteen milliseconds is not worth that.
 */

type Entry = Record<string, unknown>

/**
 * Matches the fallback the browse page used to synthesise client-side when a
 * folder has no meta.json, so moving the fan-out here changes no behaviour.
 * Duration is left out on purpose: it is detected from the video element.
 */
function defaultVideoMeta(folder: string): Entry {
  return {
    title: folder,
    videoFile: `${folder}.mp4`,
    bxFiles: [{ label: 'Default', file: `${folder}.bx` }],
  }
}

async function readEntries(
  section: 'videos' | 'playlists',
  base: string,
  key: '_folder' | '_id',
  fallback: ((id: string) => Entry) | null,
): Promise<Entry[]> {
  if (!(await manifestExists(section))) return []
  const ids = (await readManifest(section)).filter(isValidId)
  const entries = await Promise.all(
    ids.map(async (id) => {
      const meta = await readJson<Entry | null>(path.join(base, id, 'meta.json'), null)
      if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
        return { ...meta, [key]: id }
      }
      // A video with no readable meta is still watchable under the conventional
      // names; a playlist with no meta has no entry list, so it is dropped.
      return fallback ? { ...fallback(id), [key]: id } : null
    }),
  )
  return entries.filter(Boolean) as Entry[]
}

export async function GET() {
  const [videos, playlists] = await Promise.all([
    readEntries('videos', VIDEO_BASE, '_folder', defaultVideoMeta),
    readEntries('playlists', PLAYLIST_BASE, '_id', null),
  ])
  return jsonResponse({ videos, playlists })
}
