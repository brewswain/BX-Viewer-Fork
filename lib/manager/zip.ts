import archiver from 'archiver'
import path from 'node:path'
import { PLAYLIST_BASE, VIDEO_BASE } from '@/lib/paths'
import { isDirectory, listFilesRecursive } from './fsx'

/**
 * Already-compressed payloads: deflating them burns CPU for ~0% gain, so they
 * go in with STORE. Everything else (meta.json, .bx path data, fonts) deflates.
 * Verbatim copy of manager.py's `_STORED_EXTS`.
 */
export const STORED_EXTS = new Set([
  '.mp4',
  '.webm',
  '.mkv',
  '.mov',
  '.avi',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.zip',
  '.gz',
  '.bz2',
  '.xz',
  '.zst',
])

async function addFolder(
  archive: archiver.Archiver,
  basePath: string,
  arcPrefix: string,
): Promise<void> {
  for (const rel of await listFilesRecursive(basePath)) {
    const store = STORED_EXTS.has(path.extname(rel).toLowerCase())
    archive.file(path.join(basePath, rel), {
      name: `${arcPrefix}/${rel}`,
      store,
    } as archiver.EntryData)
  }
}

/**
 * Build the export archive as a live stream.
 *
 * Nothing is buffered: entries are queued and archiver pulls each file off disk
 * as the client drains the response, so exporting 50 GB of video costs a few MB
 * of RSS. Missing folders are skipped silently, as in manager.py.
 */
export function buildExportArchive(videoIds: string[], playlistIds: string[]): archiver.Archiver {
  const archive = archiver('zip', { forceZip64: true })

  // ENOENT on an individual file is a warning in archiver — it keeps going,
  // matching the Python's tolerance for a package that lost a file.
  archive.on('warning', (err) => {
    console.warn(`[export] ${err.message}`)
  })

  // archiver signals hard failures with a bare 'error' emit and leaves the
  // stream open, which would hang the download forever. Destroying it lets the
  // web-stream wrapper tear the response down instead.
  let torndown = false
  const teardown = () => {
    if (torndown) return
    torndown = true
    archive.destroy()
  }
  archive.on('error', (err) => {
    console.error(`[export] ${err.message}`)
    teardown()
  })

  void (async () => {
    try {
      for (const vid of videoIds) {
        const folder = path.join(VIDEO_BASE, vid)
        if (await isDirectory(folder)) await addFolder(archive, folder, `videos/${vid}`)
      }
      for (const pid of playlistIds) {
        const folder = path.join(PLAYLIST_BASE, pid)
        if (await isDirectory(folder)) await addFolder(archive, folder, `playlists/${pid}`)
      }
      await archive.finalize()
    } catch (e) {
      console.error(`[export] ${(e as Error).message}`)
      teardown()
    }
  })()

  return archive
}

/** manager.py: `re.sub(r'[^\w\-. ]', '_', name.strip()) or "package"`, then `.zip`. */
export function sanitizeExportFilename(raw: unknown): string {
  const trimmed = (typeof raw === 'string' ? raw : 'package').trim()
  // Python's `\w` is Unicode-aware, unlike JS's ASCII-only `\w`.
  let name = trimmed.replace(/[^\p{L}\p{N}_\-. ]/gu, '_')
  if (!name) name = 'package'
  if (!name.endsWith('.zip')) name += '.zip'
  return name
}
