import path from 'node:path'
import { jsonResponse, readJson } from '@/lib/json'
import { manifestExists, readManifest } from '@/lib/manager/manifest'
import { scanPoppersCycles } from '@/lib/player/poppersScan'
import { PLAYLIST_BASE, VIDEO_BASE, isValidId, videoDir } from '@/lib/paths'

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

/**
 * Stamp each video with the breath cycles its paths deal, for the browse grid's
 * `poppers` pill.
 *
 * It has to be derived here rather than stored in meta.json, because the cards
 * are the only evidence and a stored number would drift the moment a .bx is
 * rewritten. The cost is bounded by an mtime cache inside the scan, so this is a
 * stat per .bx after the first request; see `lib/player/poppersScan.ts` for why
 * the route's own no-cache rule does not carry to it.
 */
async function stampPoppers(videos: Entry[]): Promise<void> {
  await Promise.all(
    videos.map(async (v) => {
      const folder = v._folder
      if (typeof folder !== 'string') return
      const files = Array.isArray(v.bxFiles)
        ? (v.bxFiles as Array<{ file?: unknown }>)
            .map((b) => (b && typeof b.file === 'string' ? b.file : null))
            .filter((f): f is string => f !== null)
        : []
      const cycles = await scanPoppersCycles(videoDir(folder), files)
      if (cycles > 0) v.poppersCycles = cycles
    }),
  )
}

export async function GET() {
  const [videos, playlists] = await Promise.all([
    readEntries('videos', VIDEO_BASE, '_folder', defaultVideoMeta),
    readEntries('playlists', PLAYLIST_BASE, '_id', null),
  ])
  await stampPoppers(videos)
  return jsonResponse({ videos, playlists })
}
