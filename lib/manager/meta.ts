import path from 'node:path'
import { PLAYLIST_BASE, VIDEO_BASE } from '@/lib/paths'
import { pathExists, readJsonStrict, sortedDirNames } from './fsx'
import { readManifest } from './manifest'

export type Meta = Record<string, unknown>

const VIDEO_EXTS = ['.mp4', '.webm', '.mkv', '.mov']

/**
 * manager.py `_synthesize_meta`: meta.json is optional, so when it is absent we
 * guess the package contents from the folder listing using the conventional
 * `<folder>.<ext>` names, falling back to the first matching file.
 */
export async function synthesizeMeta(folderId: string, folder: string): Promise<Meta> {
  const meta: Meta = { title: folderId }

  for (const ext of VIDEO_EXTS) {
    if (await pathExists(path.join(folder, folderId + ext))) {
      meta.videoFile = folderId + ext
      break
    }
  }
  const names = await sortedDirNames(folder)
  if (!('videoFile' in meta)) {
    for (const name of names) {
      if (VIDEO_EXTS.includes(path.extname(name).toLowerCase())) {
        meta.videoFile = name
        break
      }
    }
  }

  let bxName: string | null = null
  if (await pathExists(path.join(folder, folderId + '.bx'))) {
    bxName = folderId + '.bx'
  } else {
    for (const name of names) {
      if (path.extname(name).toLowerCase() === '.bx') {
        bxName = name
        break
      }
    }
  }
  if (bxName) meta.bxFiles = [{ label: 'Default', file: bxName }]

  for (const thumb of ['thumb.jpg', 'thumb.png', folderId + '.jpg', folderId + '.png']) {
    if (await pathExists(path.join(folder, thumb))) {
      meta.thumbnail = thumb
      break
    }
  }

  return meta
}

function asObject(value: unknown): Meta | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Meta) : null
}

/** manager.py `api_videos` — validates each manifest entry and annotates it. */
export async function listVideos(): Promise<Meta[]> {
  const manifest = await readManifest('videos')
  const results: Meta[] = []

  for (const folderId of manifest) {
    const folder = path.join(VIDEO_BASE, folderId)
    const metaPath = path.join(folder, 'meta.json')
    const errors: string[] = []
    const warnings: string[] = []
    let meta: Meta

    if (!(await pathExists(metaPath))) {
      if (!(await pathExists(folder))) {
        errors.push('video folder missing')
        results.push({ _folder: folderId, _errors: errors, _warnings: warnings })
        continue
      }
      meta = await synthesizeMeta(folderId, folder)
      meta._folder = folderId
      meta._synthesized = true
      warnings.push('meta.json missing')
    } else {
      try {
        const parsed = asObject(await readJsonStrict(metaPath))
        if (!parsed) throw new Error('not a JSON object')
        meta = parsed
      } catch (e) {
        errors.push(`meta.json unreadable: ${(e as Error).message}`)
        results.push({ _folder: folderId, _errors: errors, _warnings: warnings })
        continue
      }
      meta._folder = folderId
    }

    // Video file — missing is normalised to the <folder>.mp4 convention
    if (!meta.videoFile) meta.videoFile = folderId + '.mp4'
    const videoFile = String(meta.videoFile)
    if (!(await pathExists(path.join(folder, videoFile)))) {
      warnings.push(`video file missing: ${videoFile}`)
    }

    // Legacy single `bxFile` is folded into `bxFiles` so only one shape is checked
    if (!meta.bxFiles && meta.bxFile) {
      meta.bxFiles = [{ label: 'Default', file: meta.bxFile }]
    }

    const bxFiles = meta.bxFiles
    if (Array.isArray(bxFiles) && bxFiles.length > 0) {
      const first = bxFiles[0] as unknown
      const bxRef = asObject(first)?.file
      if (!bxRef) {
        errors.push('bxFiles[0].file not set in meta.json')
      } else if (!(await pathExists(path.join(folder, String(bxRef))))) {
        errors.push(`bx file missing: ${bxRef}`)
      }
    } else {
      errors.push('no bxFiles set in meta.json')
    }

    const thumbnail = meta.thumbnail
    if (!thumbnail) {
      warnings.push('no thumbnail set')
    } else if (!(await pathExists(path.join(folder, String(thumbnail))))) {
      warnings.push(`thumbnail missing: ${thumbnail}`)
    }

    meta._errors = errors
    meta._warnings = warnings
    results.push(meta)
  }

  return results
}

/** manager.py `api_playlists`. */
export async function listPlaylists(): Promise<Meta[]> {
  const manifest = await readManifest('playlists')
  const results: Meta[] = []

  for (const plId of manifest) {
    const folder = path.join(PLAYLIST_BASE, plId)
    const plPath = path.join(folder, 'meta.json')
    const errors: string[] = []
    const warnings: string[] = []

    if (!(await pathExists(plPath))) {
      errors.push('meta.json missing')
      results.push({ _id: plId, _errors: errors, _warnings: warnings })
      continue
    }

    let data: Meta
    try {
      const parsed = asObject(await readJsonStrict(plPath))
      if (!parsed) throw new Error('not a JSON object')
      data = parsed
    } catch (e) {
      errors.push(`meta.json unreadable: ${(e as Error).message}`)
      results.push({ _id: plId, _errors: errors, _warnings: warnings })
      continue
    }

    data._id = plId

    const thumbnail = data.thumbnail
    if (!thumbnail) {
      warnings.push('no thumbnail set')
    } else if (!(await pathExists(path.join(folder, String(thumbnail))))) {
      warnings.push(`thumbnail missing: ${thumbnail}`)
    }

    data._errors = errors
    data._warnings = warnings
    results.push(data)
  }

  return results
}
