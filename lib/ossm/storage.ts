/**
 * Server-side filesystem layer for the OSSM Sauce export.
 *
 * OSSM Sauce keeps its library in `<Documents>/OSSM Sauce/` — `Paths/` (flat,
 * `.bx`/`.funscript`) and `Playlists/` (`.bxpl`), both created at startup by
 * `ossm_sauce.gd:446` (`check_root_directory`) under
 * `OS.get_system_dir(SYSTEM_DIR_DOCUMENTS)` (`ossm_sauce.gd:168-171`). Finding
 * that folder is the whole difficulty here: "Documents" is not `~/Documents` on
 * Windows once OneDrive redirects it, and writing to the wrong one produces a
 * folder the app never reads — no error, just an export that appears to have
 * vanished. So the resolver mirrors what Godot itself asks the OS, per
 * platform, and prefers a directory that already holds an install over any
 * guess.
 *
 * Known gap: the app has a custom paths folder setting, and
 * `_resolve_storage_dir` (`ossm_sauce.gd:2326-2333`) redirects the `paths`
 * category — and only that category — to it. Playlists stay under Documents.
 * Nothing here models that, so with one set an install puts the `.bxpl` where
 * the app reads it and the `.bx` files where it does not, and still reports
 * success. `OSSM_SAUCE_DIR` / `ossmSauceDir` don't help: they move the whole
 * tree. See `docs/ossm-export.md`.
 *
 * Nothing here overwrites: an existing path file is either recognised as
 * byte-identical (and skipped) or sidestepped with a suffixed name.
 */

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { readJson } from '@/lib/json'
import { isDirectory, pathExists } from '@/lib/manager/fsx'
import { CONFIG_PATH } from '@/lib/paths'
import { bxplBody, sanitizeBxplName, suffixName } from './naming'
import type {
  OssmCandidate,
  OssmFileStatus,
  OssmInstallResult,
  OssmPlannedFile,
  OssmPlaylist,
  OssmTarget,
} from './types'

const execFileAsync = promisify(execFile)

/** The three names `check_root_directory` guarantees exist. */
const ROOT_FOLDER = 'OSSM Sauce'
const PATHS_DIR = 'Paths'
const PLAYLISTS_DIR = 'Playlists'
const SETTINGS_FILE = 'UserSettings.cfg'

/** Only `ossmSauceDir` is read; the file holds unrelated launcher keys too. */
type OssmConfig = { ossmSauceDir?: string }

/**
 * Injection seam for the resolver. Every default reads the real process, so
 * production callers pass nothing; tests fake a platform instead of skipping
 * the cases they can't run on.
 */
export type OssmResolveOptions = {
  platform?: NodeJS.Platform | string
  env?: Record<string, string | undefined>
  /** `null` models a host where the home directory can't be determined. */
  home?: string | null
  configPath?: string
  /** Windows known-folder lookup, so tests never spawn `reg`. */
  lookupKnownFolder?: (
    env: Record<string, string | undefined>,
    home: string | null,
  ) => Promise<string | null>
}

/* -------------------------------------------------------------------------- */
/* platform rules                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Windows and macOS are case-insensitive but case-*preserving*, so `Hard.bx`
 * and `hard.bx` are the same file there and two different files on Linux. This
 * single predicate decides both name-clash detection and whether a copy could
 * clobber something — get it wrong and a mac export silently replaces an
 * unrelated path, or a Linux export invents a suffix it didn't need.
 */
function isCaseInsensitive(platform: NodeJS.Platform | string): boolean {
  return platform === 'win32' || platform === 'darwin'
}

function foldName(name: string, platform: NodeJS.Platform | string): string {
  return isCaseInsensitive(platform) ? name.toLowerCase() : name
}

/** `~/x` from a config file or an env var that was quoted past the shell. */
function expandUser(raw: string, home: string | null): string {
  if (!home) return raw
  if (raw === '~') return home
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(home, raw.slice(2))
  return raw
}

/**
 * Accept either the `OSSM Sauce` folder or the Documents folder that contains
 * it — users reasonably read "point this at OSSM Sauce" both ways, and a
 * doubled `OSSM Sauce/OSSM Sauce` is a silent miss. Compared case-folded on
 * every platform: a hand-typed `ossm sauce` is far likelier to be the app's
 * folder than a genuine second directory of that name.
 */
function toRootFolder(raw: string, home: string | null): string {
  const abs = path.resolve(expandUser(raw.trim(), home))
  const base = path.basename(abs)
  return base.toLowerCase() === ROOT_FOLDER.toLowerCase() ? abs : path.join(abs, ROOT_FOLDER)
}

/** "A real install lives here" — the two things Godot creates on first run. */
async function hasInstall(rootDir: string): Promise<boolean> {
  if (await pathExists(path.join(rootDir, SETTINGS_FILE))) return true
  return isDirectory(path.join(rootDir, PATHS_DIR))
}

/**
 * `SHGetKnownFolderPath(FOLDERID_Documents)`, which is what Godot calls, read
 * out of the registry value that backs it. This is the authoritative answer
 * when the `OneDrive*` env vars don't cover the redirect (Known Folder Move
 * with a non-default OneDrive root, a domain-redirected profile, …). Never
 * throws: on any failure the env-var candidates stand.
 *
 * Exported so the output parsing can be tested against a real `reg` on Windows.
 */
export async function queryWindowsDocuments(
  env: Record<string, string | undefined>,
  home: string | null,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
        '/v',
        'Personal',
      ],
      { timeout: 3000, windowsHide: true },
    )
    const match = stdout.match(/Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/i)
    if (!match) return null
    const profile = env.USERPROFILE || home || ''
    const value = match[1].trim().replace(/%USERPROFILE%/gi, profile)
    return value ? path.resolve(value) : null
  } catch {
    return null
  }
}

/** `XDG_DOCUMENTS_DIR` out of `user-dirs.dirs`, the file `xdg-user-dir` reads. */
async function readXdgDocuments(
  env: Record<string, string | undefined>,
  home: string,
): Promise<string | null> {
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config')
  let text: string
  try {
    text = await fs.readFile(path.join(configHome, 'user-dirs.dirs'), 'utf8')
  } catch {
    return null
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^XDG_DOCUMENTS_DIR\s*=\s*(.*)$/)
    if (!match) continue
    // Values are shell-quoted and usually relative to $HOME: `"$HOME/Documents"`.
    const value = match[1].trim().replace(/^["']|["']$/g, '')
    const expanded = value.replace(/\$\{?HOME\}?/g, home)
    if (expanded) return path.resolve(expanded)
  }
  return null
}

/**
 * Documents-folder candidates in preference order, mirroring Godot's
 * per-platform `OS.get_system_dir` implementation:
 * win32 `SHGetKnownFolderPath` (OneDrive-redirectable), darwin
 * `NSSearchPathForDirectoriesInDomains` = `~/Documents` (which *is* the synced
 * location when iCloud Desktop & Documents is on, so no iCloud special case),
 * linux `xdg-user-dir DOCUMENTS`.
 */
async function documentsCandidates(
  platform: NodeJS.Platform | string,
  env: Record<string, string | undefined>,
  home: string | null,
): Promise<string[]> {
  const out: string[] = []
  const push = (p: string | null | undefined) => {
    if (!p) return
    const abs = path.resolve(p)
    if (!out.some((existing) => existing === abs)) out.push(abs)
  }

  if (platform === 'win32') {
    if (env.OneDrive) push(path.join(env.OneDrive, 'Documents'))
    if (env.OneDriveCommercial) push(path.join(env.OneDriveCommercial, 'Documents'))
    const profile = env.USERPROFILE || home
    if (profile) push(path.join(profile, 'Documents'))
    return out
  }

  if (platform === 'linux') {
    push(env.XDG_DOCUMENTS_DIR)
    if (home) {
      push(await readXdgDocuments(env, home))
      push(path.join(home, 'Documents'))
    }
    return out
  }

  // darwin and anything else Node reports: Documents under the home dir.
  if (home) push(path.join(home, 'Documents'))
  return out
}

/* -------------------------------------------------------------------------- */
/* resolve                                                                    */
/* -------------------------------------------------------------------------- */

export async function resolveOssmTarget(options: OssmResolveOptions = {}): Promise<OssmTarget> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home !== undefined ? options.home : safeHomedir()
  const configPath = options.configPath ?? CONFIG_PATH
  const lookupKnownFolder = options.lookupKnownFolder ?? queryWindowsDocuments

  const fromEnv = (env.OSSM_SAUCE_DIR || '').trim()
  if (fromEnv) {
    const dir = toRootFolder(fromEnv, home)
    return { dir, source: 'env', exists: await hasInstall(dir), platform }
  }

  const config = await readJson<OssmConfig>(configPath, {})
  const fromConfig = (config.ossmSauceDir || '').trim()
  if (fromConfig) {
    const dir = toRootFolder(fromConfig, home)
    return { dir, source: 'config', exists: await hasInstall(dir), platform }
  }

  const candidates = await documentsCandidates(platform, env, home)

  // An install-bearing candidate settles it, whatever the env vars imply.
  for (const docs of candidates) {
    const dir = path.join(docs, ROOT_FOLDER)
    if (await hasInstall(dir)) return { dir, source: 'detected', exists: true, platform }
  }

  // Nothing installed yet, so fall back to the best guess at where the app
  // *will* create it. On Windows the registry answer is what Godot will get, so
  // it outranks the env-var guesses even when it doesn't exist yet.
  if (platform === 'win32') {
    // Spawning anything must not be able to fail the resolve.
    const known = await lookupKnownFolder(env, home).catch(() => null)
    if (known) {
      const dir = path.join(known, ROOT_FOLDER)
      if (await hasInstall(dir)) return { dir, source: 'detected', exists: true, platform }
      return { dir, source: 'default', exists: false, platform }
    }
  }

  for (const docs of candidates) {
    if (await isDirectory(docs)) {
      return { dir: path.join(docs, ROOT_FOLDER), source: 'default', exists: false, platform }
    }
  }
  if (candidates.length) {
    return { dir: path.join(candidates[0], ROOT_FOLDER), source: 'default', exists: false, platform }
  }
  return { dir: null, source: 'unresolved', exists: false, platform }
}

function safeHomedir(): string | null {
  try {
    return os.homedir() || null
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* plan                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One name that is already claimed inside `Paths/`, either by a file on disk or
 * by an earlier file in this same batch. `size`/`sha` are filled in only when a
 * clash actually needs resolving — hashing every path in a large `Paths/` to
 * plan two files would be pointless work.
 */
type Slot = {
  /** As stored, so an identical match reports the on-disk casing. */
  name: string
  file: string
  size?: number | null
  sha?: string | null
}

async function sha256File(file: string): Promise<string | null> {
  try {
    return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')
  } catch {
    return null
  }
}

async function slotSize(slot: Slot): Promise<number | null> {
  if (slot.size === undefined) {
    try {
      slot.size = (await fs.stat(slot.file)).size
    } catch {
      slot.size = null
    }
  }
  return slot.size
}

async function slotSha(slot: Slot): Promise<string | null> {
  if (slot.sha === undefined) slot.sha = await sha256File(slot.file)
  return slot.sha
}

/** `name` lands in a `path.join`, so anything but a bare filename is a bug. */
function assertBareName(name: string): void {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`Invalid OSSM path filename: ${JSON.stringify(name)}`)
  }
}

/**
 * Decide the final name and status of every candidate without touching disk.
 *
 * A name already in `Paths/` is only reused when the bytes match; otherwise the
 * new file takes a suffixed name derived from its own hash, so the same export
 * run twice is stable and an unrelated path is never replaced.
 */
export async function planFiles(
  target: OssmTarget,
  candidates: OssmCandidate[],
): Promise<OssmPlannedFile[]> {
  const platform = target.platform
  // A null target still plans (the zip download uses the same plan); with
  // nowhere to compare against, every file is simply new.
  const pathsDir = target.dir ? path.join(target.dir, PATHS_DIR) : null

  const claimed = new Map<string, Slot>()
  if (pathsDir) {
    let entries: string[] = []
    try {
      entries = (await fs.readdir(pathsDir, { withFileTypes: true }))
        .filter((e) => e.isFile())
        .map((e) => e.name)
    } catch {
      /* no Paths/ yet — installFiles creates it */
    }
    for (const name of entries) {
      claimed.set(foldName(name, platform), { name, file: path.join(pathsDir, name) })
    }
  }

  const planned: OssmPlannedFile[] = []
  for (const candidate of candidates) {
    assertBareName(candidate.name)

    let stat
    try {
      stat = await fs.stat(candidate.sourcePath)
      if (!stat.isFile()) throw new Error('not a file')
    } catch {
      // Names the library entry, not the absolute path: this message is returned
      // to the browser, which may be another machine on the network.
      throw new Error(
        `Cannot export "${candidate.sourceFile}" from ${candidate.videoId}: missing or unreadable.`,
      )
    }
    const size = stat.size

    let sourceSha: string | null | undefined
    const sha = async (): Promise<string | null> => {
      if (sourceSha === undefined) sourceSha = await sha256File(candidate.sourcePath)
      return sourceSha
    }

    let name = candidate.name
    let status: OssmFileStatus = 'new'
    let attempt = 0
    for (;;) {
      const held = claimed.get(foldName(name, platform))
      if (!held) {
        status = attempt === 0 ? 'new' : 'renamed'
        break
      }
      const heldSize = await slotSize(held)
      if (heldSize === size) {
        const [a, b] = [await slotSha(held), await sha()]
        if (a && b && a === b) {
          // Same bytes already there: reuse the stored name so the playlist
          // line matches what `Paths/` actually contains.
          name = held.name
          status = 'identical'
          break
        }
      }
      // An unreadable or differing file counts as occupied. Suffix from the
      // source hash so re-exporting the same file picks the same name again.
      const short = (await sha())?.slice(0, 8) ?? 'export'
      attempt += 1
      name = suffixName(candidate.name, attempt === 1 ? short : `${short}-${attempt}`)
      if (attempt > 100) throw new Error(`Cannot find a free name for "${candidate.name}".`)
    }

    claimed.set(foldName(name, platform), { name, file: candidate.sourcePath, size })
    planned.push({ ...candidate, name, status, bytes: size })
  }
  return planned
}

/* -------------------------------------------------------------------------- */
/* install                                                                    */
/* -------------------------------------------------------------------------- */

/** `<name>.bxpl`, tolerating a caller that already added the extension. */
function bxplFileBase(rawName: string): string {
  const trimmed = (rawName || '').trim()
  const stripped = /\.bxpl$/i.test(trimmed) ? trimmed.slice(0, -5) : trimmed
  return sanitizeBxplName(stripped)
}

async function firstFreeName(dir: string, base: string, ext: string): Promise<string> {
  if (!(await pathExists(path.join(dir, base + ext)))) return base + ext
  for (let n = 2; n < 1000; n++) {
    const name = `${base} (${n})${ext}`
    if (!(await pathExists(path.join(dir, name)))) return name
  }
  throw new Error(`Too many files named like "${base}${ext}" in ${dir}.`)
}

/**
 * Copy the plan into `Paths/` and write the playlist.
 *
 * Documents is on the system volume while the library may not be, so every copy
 * here is genuinely cross-volume: `fs.copyFile` writes straight to the
 * destination rather than staging in `%TEMP%` and moving (see `makeTempDir` in
 * `lib/manager/fsx.ts` — a temp-then-move would degrade into a second full copy).
 */
export async function installFiles(
  target: OssmTarget,
  planned: OssmPlannedFile[],
  playlist: OssmPlaylist | null,
): Promise<OssmInstallResult> {
  if (!target.dir) {
    throw new Error(
      "Couldn't locate the OSSM Sauce folder. Set OSSM_SAUCE_DIR or ossmSauceDir in config.json.",
    )
  }

  const pathsDir = path.join(target.dir, PATHS_DIR)
  const playlistsDir = path.join(target.dir, PLAYLISTS_DIR)
  // Both, always — that is the layout the app creates for itself, and a
  // paths-only export still shouldn't leave a half-built folder.
  await fs.mkdir(pathsDir, { recursive: true })
  await fs.mkdir(playlistsDir, { recursive: true })

  const written: string[] = []
  const skipped: string[] = []
  const warnings: string[] = []

  for (const file of planned) {
    assertBareName(file.name)
    if (file.status === 'identical') {
      skipped.push(file.name)
      continue
    }
    written.push(await copyWithoutClobber(file, pathsDir, warnings))
  }

  let playlistName: string | null = null
  if (playlist) {
    const base = bxplFileBase(playlist.name)
    const wanted = `${base}.bxpl`
    const body = bxplBody(playlist)
    // A file already holding exactly these lines *is* this playlist, so
    // re-installing the same export is a no-op rather than another
    // "Set (2).bxpl". Matches how paths dedupe on content; only a playlist of
    // the same name with *different* lines gets a suffix.
    if ((await readTextOrNull(path.join(playlistsDir, wanted))) === body) {
      playlistName = wanted
    } else {
      playlistName = await firstFreeName(playlistsDir, base, '.bxpl')
      if (playlistName !== wanted) {
        warnings.push(
          `A playlist named "${wanted}" was already in Playlists/ with different contents, so this export was written as "${playlistName}".`,
        )
      }
      await fs.writeFile(path.join(playlistsDir, playlistName), body, 'utf8')
    }
  }

  return { dir: target.dir, written, skipped, playlist: playlistName, warnings }
}

async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * `COPYFILE_EXCL` closes the gap between planning and installing: if something
 * claimed the name in between we compare bytes and either skip or suffix, never
 * overwrite.
 */
async function copyWithoutClobber(
  file: OssmPlannedFile,
  pathsDir: string,
  warnings: string[],
): Promise<string> {
  let name = file.name
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fs.copyFile(file.sourcePath, path.join(pathsDir, name), fs.constants.COPYFILE_EXCL)
      return name
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const [a, b] = [
        await sha256File(path.join(pathsDir, name)),
        await sha256File(file.sourcePath),
      ]
      if (a && b && a === b) return name // appeared meanwhile, same bytes
      name = suffixName(file.name, `${attempt + 2}`)
      warnings.push(
        `"${file.name}" appeared in Paths/ after the plan was made, so it was written as "${name}".`,
      )
    }
  }
  throw new Error(`Cannot find a free name for "${file.name}" in ${pathsDir}.`)
}
