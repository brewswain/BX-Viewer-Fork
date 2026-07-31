import type { NextResponse } from 'next/server'
import fs from 'node:fs/promises'
import path from 'node:path'
import { jsonError, jsonResponse, writeJson } from '@/lib/json'
import { PLAYLIST_BASE, VIDEO_BASE, isValidId } from '@/lib/paths'
import { bumpVersion } from '@/lib/version'
import { tallyPlaylistDuration } from './duration'
import { errorMessage } from './endpoints'
import { moveInto, pathExists, rmrf, round3 } from './fsx'
import {
  manifestExists,
  readManifest,
  readManifestOrCreate,
  writeManifest,
  type Section,
} from './manifest'
import { isMultipart, parseMultipart, type ParsedForm } from './multipart'

type Meta = Record<string, unknown>

function asMeta(value: unknown): Meta | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Meta) : null
}

/** The `meta` form field carries the whole meta.json as a JSON string. */
function parseMetaField(form: ParsedForm): { meta: Meta } | { error: NextResponse } {
  let parsed: unknown
  try {
    parsed = JSON.parse(form.fields.meta ?? '{}')
  } catch (e) {
    return { error: jsonError(`Invalid meta JSON: ${errorMessage(e)}`, 400) }
  }
  const meta = asMeta(parsed)
  if (!meta) return { error: jsonError('Invalid meta JSON: expected an object', 400) }
  return { meta }
}

/** Move every `font_0`, `font_1`, … part into the package folder. */
async function moveFonts(form: ParsedForm, folderPath: string): Promise<void> {
  for (let i = 0; form.files[`font_${i}`]; i++) {
    const font = form.files[`font_${i}`]
    if (font.filename) await moveInto(font.tmpPath, path.join(folderPath, font.filename))
  }
}

/** Rewrite the manifest entry for a renamed folder, leaving its position alone. */
async function renameInManifest(
  section: Section,
  oldId: string,
  newId: string,
): Promise<void> {
  if (!(await manifestExists(section))) return
  const manifest = await readManifest(section)
  const index = manifest.indexOf(oldId)
  if (index === -1) return
  manifest[index] = newId
  await writeManifest(section, manifest)
}

// ── Videos ────────────────────────────────────────────────────────────────────

export async function createVideo(request: Request): Promise<NextResponse> {
  if (!isMultipart(request)) return jsonError('Expected multipart/form-data', 400)

  let form: ParsedForm
  try {
    // Temp dir lives under videos/ so the moves below are renames, not copies.
    form = await parseMultipart(request, VIDEO_BASE)
  } catch (e) {
    return jsonError(`Failed to parse form data: ${errorMessage(e)}`, 400)
  }

  try {
    const folderId = (form.fields.folderId ?? '').trim()
    if (!folderId) return jsonError('folderId is required', 400)
    if (!isValidId(folderId)) return jsonError('Invalid folder ID', 400)

    const folderPath = path.join(VIDEO_BASE, folderId)
    if (await pathExists(folderPath)) {
      return jsonError(`Folder "${folderId}" already exists`, 409)
    }

    const video = form.files.video
    if (!video) return jsonError('Video file is required', 400)
    if (!video.filename) return jsonError('Video file has no name', 400)

    const parsed = parseMetaField(form)
    if ('error' in parsed) return parsed.error
    const meta = parsed.meta

    await fs.mkdir(folderPath, { recursive: false })
    try {
      await moveInto(video.tmpPath, path.join(folderPath, video.filename))
      meta.videoFile = video.filename

      const thumbnail = form.files.thumbnail
      if (thumbnail?.filename) {
        await moveInto(thumbnail.tmpPath, path.join(folderPath, thumbnail.filename))
        meta.thumbnail = thumbnail.filename
      }

      // BX path files arrive as bx_0, bx_1, … with a parallel bxLabel_<i>.
      const bxFilesMeta: { label: string; file: string }[] = []
      for (let i = 0; form.files[`bx_${i}`]; i++) {
        const bx = form.files[`bx_${i}`]
        const label = form.fields[`bxLabel_${i}`] ?? 'Default'
        if (bx.filename) {
          await moveInto(bx.tmpPath, path.join(folderPath, bx.filename))
          bxFilesMeta.push({ label, file: bx.filename })
        }
      }
      if (bxFilesMeta.length > 0) meta.bxFiles = bxFilesMeta

      await moveFonts(form, folderPath)

      await writeJson(path.join(folderPath, 'meta.json'), meta)

      // Prepended, not appended — new packages surface at the top of Browse.
      const manifest = await readManifestOrCreate('videos')
      manifest.unshift(folderId)
      await writeManifest('videos', manifest)

      bumpVersion()
      return jsonResponse({ created: folderId })
    } catch (e) {
      await rmrf(folderPath)
      return jsonError(`Failed to create package: ${errorMessage(e)}`, 500)
    }
  } finally {
    await form.cleanup()
  }
}

export async function updateVideo(request: Request, folderId: string): Promise<NextResponse> {
  if (!isValidId(folderId)) return jsonError('Invalid folder id', 400)
  if (!isMultipart(request)) return jsonError('Expected multipart/form-data', 400)

  let folderPath = path.join(VIDEO_BASE, folderId)
  if (!(await pathExists(folderPath))) {
    return jsonError(`Folder not found: ${folderId}`, 404)
  }

  let form: ParsedForm
  try {
    form = await parseMultipart(request, VIDEO_BASE)
  } catch (e) {
    return jsonError(`Failed to parse form data: ${errorMessage(e)}`, 400)
  }

  try {
    const parsed = parseMetaField(form)
    if ('error' in parsed) return parsed.error
    const meta = parsed.meta

    let newFolderId = (form.fields.newFolderId ?? folderId).trim()
    if (!newFolderId) newFolderId = folderId
    if (!isValidId(newFolderId)) return jsonError('Invalid new folder ID', 400)

    if (newFolderId !== folderId) {
      const newFolderPath = path.join(VIDEO_BASE, newFolderId)
      if (await pathExists(newFolderPath)) {
        return jsonError(`Folder "${newFolderId}" already exists`, 409)
      }
      await fs.rename(folderPath, newFolderPath)
      folderPath = newFolderPath
      await renameInManifest('videos', folderId, newFolderId)
    }

    try {
      // Video — replacing under a new name unlinks the old file first.
      const video = form.files.video
      if (video?.filename) {
        const oldVideo = meta.videoFile
        if (typeof oldVideo === 'string' && oldVideo && oldVideo !== video.filename) {
          await rmrf(path.join(folderPath, oldVideo))
        }
        await moveInto(video.tmpPath, path.join(folderPath, video.filename))
        meta.videoFile = video.filename
      }

      const thumbnail = form.files.thumbnail
      if (thumbnail?.filename) {
        const oldThumb = meta.thumbnail
        if (typeof oldThumb === 'string' && oldThumb && oldThumb !== thumbnail.filename) {
          await rmrf(path.join(folderPath, oldThumb))
        }
        await moveInto(thumbnail.tmpPath, path.join(folderPath, thumbnail.filename))
        meta.thumbnail = thumbnail.filename
      }

      // Update sends the full BX list: bxCount slots, each either a fresh
      // upload (bxFile_<i>) or a reference to a file already on disk
      // (bxExistingFile_<i>).
      const bxCountStr = form.fields.bxCount ?? ''
      if (/^\d+$/.test(bxCountStr)) {
        const bxCount = Number.parseInt(bxCountStr, 10)
        const bxFilesMeta: { label: string; file: string }[] = []
        for (let i = 0; i < bxCount; i++) {
          const label = form.fields[`bxLabel_${i}`] ?? 'Default'
          const uploaded = form.files[`bxFile_${i}`]
          if (uploaded) {
            if (uploaded.filename) {
              await moveInto(uploaded.tmpPath, path.join(folderPath, uploaded.filename))
              bxFilesMeta.push({ label, file: uploaded.filename })
            }
          } else if (`bxExistingFile_${i}` in form.fields) {
            const existing = form.fields[`bxExistingFile_${i}`]
            if (existing) bxFilesMeta.push({ label, file: existing })
          }
        }
        if (bxFilesMeta.length > 0) meta.bxFiles = bxFilesMeta
      }

      // Fonts — new uploads only; existing font files are left in place.
      await moveFonts(form, folderPath)

      await writeJson(path.join(folderPath, 'meta.json'), meta)
      bumpVersion()
      return jsonResponse({ updated: newFolderId, renamed: newFolderId !== folderId })
    } catch (e) {
      return jsonError(`Failed to update package: ${errorMessage(e)}`, 500)
    }
  } finally {
    await form.cleanup()
  }
}

// ── Playlists ─────────────────────────────────────────────────────────────────

export async function createPlaylist(request: Request): Promise<NextResponse> {
  if (!isMultipart(request)) return jsonError('Expected multipart/form-data', 400)

  let form: ParsedForm
  try {
    form = await parseMultipart(request, PLAYLIST_BASE)
  } catch (e) {
    return jsonError(`Failed to parse form data: ${errorMessage(e)}`, 400)
  }

  try {
    const folderId = (form.fields.folderId ?? '').trim()
    if (!folderId) return jsonError('folderId is required', 400)
    if (!isValidId(folderId)) return jsonError('Invalid folder ID', 400)

    const folderPath = path.join(PLAYLIST_BASE, folderId)
    if (await pathExists(folderPath)) {
      return jsonError(`Folder "${folderId}" already exists`, 409)
    }

    const parsed = parseMetaField(form)
    if ('error' in parsed) return parsed.error
    const meta = parsed.meta

    await fs.mkdir(folderPath, { recursive: false })
    try {
      const thumbnail = form.files.thumbnail
      if (thumbnail?.filename) {
        await moveInto(thumbnail.tmpPath, path.join(folderPath, thumbnail.filename))
        meta.thumbnail = thumbnail.filename
      }

      meta.totalDurationSecs = round3(await tallyPlaylistDuration(meta.videos))

      await writeJson(path.join(folderPath, 'meta.json'), meta)

      const manifest = await readManifestOrCreate('playlists')
      manifest.unshift(folderId)
      await writeManifest('playlists', manifest)
      bumpVersion()
      return jsonResponse({ created: folderId })
    } catch (e) {
      await rmrf(folderPath)
      return jsonError(`Failed to create playlist: ${errorMessage(e)}`, 500)
    }
  } finally {
    await form.cleanup()
  }
}

export async function updatePlaylist(request: Request, folderId: string): Promise<NextResponse> {
  if (!isValidId(folderId)) return jsonError('Invalid folder id', 400)
  if (!isMultipart(request)) return jsonError('Expected multipart/form-data', 400)

  let folderPath = path.join(PLAYLIST_BASE, folderId)
  if (!(await pathExists(folderPath))) {
    return jsonError(`Folder not found: ${folderId}`, 404)
  }

  let form: ParsedForm
  try {
    form = await parseMultipart(request, PLAYLIST_BASE)
  } catch (e) {
    return jsonError(`Failed to parse form data: ${errorMessage(e)}`, 400)
  }

  try {
    const parsed = parseMetaField(form)
    if ('error' in parsed) return parsed.error
    const meta = parsed.meta

    const newFolderId = (form.fields.newFolderId ?? folderId).trim() || folderId
    if (!isValidId(newFolderId)) return jsonError('Invalid new folder ID', 400)

    if (newFolderId !== folderId) {
      const newFolderPath = path.join(PLAYLIST_BASE, newFolderId)
      if (await pathExists(newFolderPath)) {
        return jsonError(`Folder "${newFolderId}" already exists`, 409)
      }
      await fs.rename(folderPath, newFolderPath)
      folderPath = newFolderPath
      await renameInManifest('playlists', folderId, newFolderId)
    }

    try {
      const thumbnail = form.files.thumbnail
      if (thumbnail?.filename) {
        const oldThumb = meta.thumbnail
        if (typeof oldThumb === 'string' && oldThumb && oldThumb !== thumbnail.filename) {
          await rmrf(path.join(folderPath, oldThumb))
        }
        await moveInto(thumbnail.tmpPath, path.join(folderPath, thumbnail.filename))
        meta.thumbnail = thumbnail.filename
      }

      meta.totalDurationSecs = round3(await tallyPlaylistDuration(meta.videos))

      await writeJson(path.join(folderPath, 'meta.json'), meta)
      bumpVersion()
      return jsonResponse({ updated: newFolderId, renamed: newFolderId !== folderId })
    } catch (e) {
      return jsonError(`Failed to update playlist: ${errorMessage(e)}`, 500)
    }
  } finally {
    await form.cleanup()
  }
}
