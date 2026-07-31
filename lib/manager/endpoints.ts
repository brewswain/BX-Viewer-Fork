import type { NextResponse } from 'next/server'
import path from 'node:path'
import { jsonError, jsonResponse, writeJson } from '@/lib/json'
import { isValidId } from '@/lib/paths'
import { bumpVersion } from '@/lib/version'
import { pathExists, readJsonStrict, rmrf } from './fsx'
import { baseFor, manifestExists, readManifest, writeManifest, type Section } from './manifest'

export function typeNameFor(section: Section): 'video' | 'playlist' {
  return section === 'videos' ? 'video' : 'playlist'
}

/**
 * Percent-decode a folder id out of the raw path, matching how
 * `app/videos/[...path]/route.ts` treats its segments. The try/catch keeps a
 * literal `%` in a folder name from throwing a URIError.
 */
export function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Turns an unhandled throw into a 500 with the error text, rather than a crash. */
export async function guard(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn()
  } catch (e) {
    return jsonError(errorMessage(e), 500)
  }
}

export async function handleReadMeta(section: Section, folderId: string): Promise<NextResponse> {
  if (!isValidId(folderId)) return jsonError('Invalid folder id', 400)
  const metaPath = path.join(baseFor(section), folderId, 'meta.json')
  if (!(await pathExists(metaPath))) {
    return jsonError(`meta.json not found for ${folderId}`, 404)
  }
  try {
    return jsonResponse(await readJsonStrict(metaPath))
  } catch (e) {
    return jsonError(errorMessage(e), 500)
  }
}

export async function handleWriteMeta(
  request: Request,
  section: Section,
  folderId: string,
): Promise<NextResponse> {
  if (!isValidId(folderId)) return jsonError('Invalid folder id', 400)
  const folderPath = path.join(baseFor(section), folderId)
  if (!(await pathExists(folderPath))) {
    return jsonError(`Folder not found for ${folderId}`, 404)
  }

  const raw = await request.text()
  if (raw.length === 0) return jsonError('Empty request body', 400)

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (e) {
    return jsonError(`Invalid JSON: ${errorMessage(e)}`, 400)
  }

  await writeJson(path.join(folderPath, 'meta.json'), data)
  bumpVersion()
  return jsonResponse({ saved: folderId })
}

/** Removes the folder from disk and drops its manifest entry. */
export async function handleDelete(section: Section, folderId: string): Promise<NextResponse> {
  if (!isValidId(folderId)) return jsonError('Invalid folder id', 400)
  if (!(await manifestExists(section))) {
    return jsonError(`${section}/manifest.json not found`, 404)
  }

  const manifest = await readManifest(section)
  const index = manifest.indexOf(folderId)
  if (index === -1) return jsonError(`"${folderId}" not found in manifest`, 404)

  const folderPath = path.join(baseFor(section), folderId)
  if (await pathExists(folderPath)) await rmrf(folderPath)

  manifest.splice(index, 1)
  await writeManifest(section, manifest)
  bumpVersion()
  return jsonResponse({ deleted: folderId, type: typeNameFor(section) })
}

/** Rewrites the manifest order — a permutation only, never an insertion. */
export async function handleReorder(request: Request, section: Section): Promise<NextResponse> {
  if (!(await manifestExists(section))) {
    return jsonError(`${section}/manifest.json not found`, 404)
  }

  const raw = await request.text()
  if (raw.length === 0) return jsonError('Empty request body', 400)

  let newOrder: unknown
  try {
    newOrder = JSON.parse(raw)
  } catch (e) {
    return jsonError(`Invalid JSON: ${errorMessage(e)}`, 400)
  }

  if (!Array.isArray(newOrder) || !newOrder.every((x) => typeof x === 'string')) {
    return jsonError('Expected a JSON array of strings', 400)
  }

  // Set equality: the client may only permute what is already there, so a
  // stale tab cannot inject or drop an entry.
  const current = new Set(await readManifest(section))
  const proposed = new Set(newOrder as string[])
  const sameEntries =
    proposed.size === current.size && [...proposed].every((id) => current.has(id))
  if (!sameEntries) {
    return jsonError('Reordered list must contain the same entries as the current manifest', 400)
  }

  await writeManifest(section, newOrder as string[])
  bumpVersion()
  return jsonResponse({ reordered: section, count: (newOrder as string[]).length })
}
