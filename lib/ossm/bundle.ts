/**
 * Server side of the OSSM Sauce export: turn a request into named path files,
 * `.bxpl` lines, and (for the download route) a zip.
 *
 * Everything that writes into the OSSM Sauce install lives in `./storage`; this
 * module reads the library and shapes the result.
 */

import archiver from 'archiver'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readJson } from '@/lib/json'
import { bxFilesOf, type VideoMeta } from '@/lib/manager-client'
import { isValidId, safeJoin, VIDEO_BASE } from '@/lib/paths'
import { bxplBody, ossmPathName, sanitizeBxplName, suffixName } from './naming'
import { planFiles, resolveOssmTarget } from './storage'
import type {
  OssmCandidate,
  OssmItem,
  OssmPlan,
  OssmPlannedFile,
  OssmRequest,
  OssmServerPlan,
} from './types'

/**
 * A malformed request, as opposed to a broken library entry — those only warn.
 * Routes map this to a 400 instead of letting `guard` turn it into a 500.
 */
export class OssmRequestError extends Error {}

/**
 * Identity of a source path, stable across any rename in `Paths/`. Encoded as a
 * JSON pair rather than a joined string, so no two id pairs can alias.
 */
function sourceKey(videoId: string, bxFile: string): string {
  return JSON.stringify([videoId, bxFile])
}

export type ParsedOssmRequest =
  | { ok: true; request: OssmRequest }
  | { ok: false; error: string }

/** Parse + shape-check a POST body, so all three routes validate identically. */
export function parseOssmRequest(raw: string): ParsedOssmRequest {
  if (raw.length === 0) return { ok: false, error: 'Empty request body' }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` }
  }

  const payload = (body ?? {}) as Record<string, unknown>
  if (!Array.isArray(payload.items)) return { ok: false, error: 'Expected an "items" array' }

  const items: OssmItem[] = []
  for (const entry of payload.items) {
    const item = (entry ?? {}) as Record<string, unknown>
    if (typeof item.videoId !== 'string' || typeof item.bxFile !== 'string') {
      return { ok: false, error: 'Each item needs a string videoId and bxFile' }
    }
    items.push({ videoId: item.videoId, bxFile: item.bxFile })
  }
  if (items.length === 0) return { ok: false, error: 'No paths selected' }

  return {
    ok: true,
    request: {
      items,
      playlistTitle: typeof payload.playlistTitle === 'string' ? payload.playlistTitle : null,
      bundleName: typeof payload.bundleName === 'string' ? payload.bundleName : null,
    },
  }
}

/**
 * Install is only offered to a request from the machine running the server: the
 * viewer is normally served on a LAN port, so a phone tapping Install would
 * write into the *server's* Documents folder. A guard against a confusing
 * outcome, explicitly not a security boundary — the rest of the manager API is
 * already unauthenticated on the LAN.
 */
export function isLoopbackRequest(request: Request): boolean {
  const host = (request.headers.get('host') || '').trim().toLowerCase()
  if (!host) return false
  // `[::1]:3000` keeps its brackets; `localhost:3000` splits on the port colon.
  const bare = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '[::1]' || bare === '::1'
}

/**
 * Resolve each requested (video, variant) pair to a source file and the name it
 * takes in the flat `Paths/` folder.
 *
 * `videoBase` is only overridden by tests.
 */
export async function buildCandidates(
  items: OssmItem[],
  videoBase: string = VIDEO_BASE,
): Promise<{ candidates: OssmCandidate[]; warnings: string[] }> {
  const candidates: OssmCandidate[] = []
  const warnings: string[] = []
  const byName = new Map<string, OssmCandidate>()
  const bySource = new Map<string, OssmCandidate>()
  const metaCache = new Map<string, VideoMeta | null>()

  for (const item of items) {
    const { videoId, bxFile } = item
    if (!isValidId(videoId)) {
      throw new OssmRequestError(`Invalid video id: ${JSON.stringify(videoId)}`)
    }

    // Same (video, variant) twice is one file in Paths/; the playlist may still
    // reference it on several lines, which is how OSSM Sauce repeats a track.
    if (bySource.has(sourceKey(videoId, bxFile))) continue

    if (!metaCache.has(videoId)) {
      const metaPath = path.join(videoBase, videoId, 'meta.json')
      metaCache.set(videoId, await readJson<VideoMeta | null>(metaPath, null))
    }
    const meta = metaCache.get(videoId) ?? null
    if (!meta) {
      warnings.push(`${videoId}: meta.json is missing or unreadable — skipped`)
      continue
    }

    const variants = bxFilesOf(meta)
    if (variants.length === 0) {
      warnings.push(`${videoId}: no path file in meta.json — skipped`)
      continue
    }

    // The only thing standing between this endpoint and an arbitrary file read:
    // the client picks the variant, so the name it sends must already be listed
    // in that video's own meta. A fallback here would defeat the check.
    if (!variants.some((v) => v.file === bxFile)) {
      throw new OssmRequestError(`${videoId}: "${bxFile}" is not one of its path files`)
    }

    const sourcePath = safeJoin(path.join(videoBase, videoId), [bxFile])
    if (!sourcePath) {
      warnings.push(`${videoId}: "${bxFile}" escapes its folder — skipped`)
      continue
    }

    const base = ossmPathName(videoId, bxFile, variants.length)
    let name = base
    for (let n = 2; byName.has(name); n += 1) name = suffixName(base, String(n))
    if (name !== base) {
      // Two different videos slugged to the same name — collapsing them would
      // silently swap one video's path for another's.
      const holder = byName.get(base)?.videoId
      warnings.push(`"${base}" is already used by ${holder} — exported as "${name}"`)
    }

    const candidate: OssmCandidate = { videoId, sourceFile: bxFile, sourcePath, name }
    candidates.push(candidate)
    byName.set(name, candidate)
    bySource.set(sourceKey(videoId, bxFile), candidate)
  }

  return { candidates, warnings }
}

/**
 * `.bxpl` body lines, in request order.
 *
 * The name comes from the *plan*, never from re-deriving it: a `renamed` entry
 * carries the suffixed name it actually took in `Paths/`, and a line built from
 * the original name would point the playlist at a different video's file. Items
 * that were skipped have no planned file and so contribute no line.
 */
export function bxplLinesFor(planned: OssmPlannedFile[], items: OssmItem[]): string[] {
  const names = new Map(planned.map((p) => [sourceKey(p.videoId, p.sourceFile), p.name]))
  const lines: string[] = []
  for (const item of items) {
    const name = names.get(sourceKey(item.videoId, item.bxFile))
    if (name) lines.push(name)
  }
  return lines
}

/**
 * Names for the zip download, which has no install to inspect: every entry is
 * `new` and nothing is suffixed. Unreadable sources drop out so the `.bxpl`
 * never lists a path the zip doesn't contain.
 */
export async function planForBundle(candidates: OssmCandidate[]): Promise<OssmPlannedFile[]> {
  const planned: OssmPlannedFile[] = []
  for (const c of candidates) {
    try {
      const stat = await fs.stat(c.sourcePath)
      planned.push({ ...c, status: 'new', bytes: stat.size })
    } catch {
      console.warn(`[ossm] ${c.videoId}: cannot read ${c.sourceFile} — left out of the bundle`)
    }
  }
  return planned
}

/** ≤8 lines, because it is read in a zip preview pane, not a browser. */
function installNotes(): string {
  return [
    'OSSM Sauce export',
    '',
    'Extract this zip over your OSSM Sauce data folder, keeping Paths/ and Playlists/ as they are:',
    '  Windows        %USERPROFILE%\\Documents\\OSSM Sauce',
    '                 (OneDrive Documents: %USERPROFILE%\\OneDrive\\Documents\\OSSM Sauce)',
    '  macOS / Linux  ~/Documents/OSSM Sauce',
    '',
    'Paths/ holds the path files; the .bxpl in Playlists/ lists them by filename.',
  ].join('\n')
}

/**
 * The download as a live stream, laid out so the user extracts it straight over
 * `<Documents>/OSSM Sauce/`.
 *
 * `playlist.name` is expected to be sanitized already (`sanitizeBxplName`).
 */
export function buildOssmArchive(
  planned: OssmPlannedFile[],
  playlist: { name: string; lines: string[] } | null,
): archiver.Archiver {
  const archive = archiver('zip')

  // ENOENT on one entry is a warning in archiver — it keeps going, so a library
  // that lost a file still exports.
  archive.on('warning', (err) => {
    console.warn(`[ossm] ${err.message}`)
  })

  // archiver signals hard failures with a bare 'error' emit and leaves the
  // stream open, which would hang the response forever. Destroying it lets the
  // web-stream wrapper tear the response down instead.
  let torndown = false
  const teardown = () => {
    if (torndown) return
    torndown = true
    archive.destroy()
  }
  archive.on('error', (err) => {
    console.error(`[ossm] ${err.message}`)
    teardown()
  })

  void (async () => {
    try {
      archive.append(`${installNotes()}\n`, { name: 'HOW-TO-INSTALL.txt' })
      // Path data is JSON, so it deflates well — no STORE special case.
      for (const file of planned) archive.file(file.sourcePath, { name: `Paths/${file.name}` })
      if (playlist) {
        archive.append(bxplBody(playlist.lines), { name: `Playlists/${playlist.name}.bxpl` })
      }
      await archive.finalize()
    } catch (e) {
      console.error(`[ossm] ${(e as Error).message}`)
      teardown()
    }
  })()

  return archive
}

/** `<name>-ossm.zip`, with the same character class as the library exporter. */
export function ossmBundleFilename(raw: unknown): string {
  const trimmed = (typeof raw === 'string' ? raw : '').trim().replace(/\.zip$/i, '')
  // Explicit Unicode classes — JS's `\w` is ASCII-only, which would mangle
  // non-Latin titles into underscores.
  const name = trimmed.replace(/[^\p{L}\p{N}_\-. ]/gu, '_').replace(/[. ]+$/, '')
  return `${name || 'paths'}-ossm.zip`
}

/** The `.bxpl` for a request, or null for a paths-only export. */
export function playlistFor(
  request: OssmRequest,
  planned: OssmPlannedFile[],
): { name: string; lines: string[] } | null {
  if (!request.playlistTitle) return null
  return {
    name: sanitizeBxplName(request.playlistTitle),
    lines: bxplLinesFor(planned, request.items),
  }
}

/**
 * The dry run behind both `/plan` and `/install` — install re-plans through this
 * rather than trusting a client-supplied plan. Read-only: it inspects `Paths/`
 * but never creates the target folders.
 */
export async function buildPlan(
  request: OssmRequest,
  canInstall: boolean,
): Promise<OssmServerPlan> {
  const target = await resolveOssmTarget()
  const { candidates, warnings } = await buildCandidates(request.items)
  const files = await planFiles(target, candidates)
  return {
    target,
    canInstall,
    files,
    playlist: playlistFor(request, files),
    warnings,
  }
}

/**
 * Strip the server-only fields before a plan is serialised. Written out field by
 * field rather than by omission, so a field added to `OssmPlannedFile` later has
 * to be opted in to the response instead of leaking by default.
 */
export function toWirePlan(plan: OssmServerPlan): OssmPlan {
  return {
    target: plan.target,
    canInstall: plan.canInstall,
    playlist: plan.playlist,
    warnings: plan.warnings,
    files: plan.files.map((f) => ({
      videoId: f.videoId,
      sourceFile: f.sourceFile,
      name: f.name,
      status: f.status,
      bytes: f.bytes,
    })),
  }
}
