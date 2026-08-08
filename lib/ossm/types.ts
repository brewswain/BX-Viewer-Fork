/**
 * Shared shapes for the OSSM Sauce export/install feature.
 *
 * The unit of work is a flat list of (video, .bx variant) pairs plus an
 * optional playlist name. That shape covers all three entry points — a whole
 * playlist, one path from the watch page, or a bulk selection in the manager —
 * so the routes only ever implement one contract.
 */

/** One path to export, as the client resolved it (honouring live variant switches). */
export type OssmItem = {
  videoId: string
  /** Filename inside `videos/<videoId>/`, and it must be listed in that video's meta. */
  bxFile: string
}

export type OssmRequest = OssmFlags & {
  items: OssmItem[]
  /** Becomes the `.bxpl` filename. Omit for a paths-only export (watch page). */
  playlistTitle?: string | null
  /** Zip filename, download route only. */
  bundleName?: string | null
}

/**
 * Playlist-level shuffle and loop, as the export overlay left them.
 *
 * `null` means the user said nothing, and it is emphatically not `false`. The
 * app writes both toggles from any v2 file it loads — `_parse_v2` reports
 * `has_flags` as true unconditionally (`playlist_format.gd:135`) and
 * `apply_playlist` takes that as permission (`ossm_sauce.gd:1019-1022`) — so a
 * v2 export that guesses `false` turns off a shuffle the user had on. Legacy v1
 * carries no flags and the app leaves them alone, which is what an unset pair is
 * emitted as. See `bxplBody`.
 *
 * Set as a pair or not at all: the format cannot state one without the other.
 */
export type OssmFlags = {
  shuffle?: boolean | null
  loop?: boolean | null
}

/**
 * One `.bxpl` entry.
 *
 * Only `path` today. The v2 format also carries `mode`/`count`/`seconds` and
 * `video_offset_ms` (`playlist_format.gd:141`), and this is the shape they land
 * on once this exporter has a source for them. An object rather than a bare
 * filename so that adding one is a field on a type, not a change of currency
 * through all three export routes.
 */
export type OssmEntry = {
  /** Bare filename, resolved against `Paths/` by name alone. */
  path: string
}

/** A `.bxpl` as planned: its filename stem, its entries, and its flags. */
export type OssmPlaylist = OssmFlags & {
  /** Sanitized (`sanitizeBxplName`), without the extension. */
  name: string
  entries: OssmEntry[]
}

/**
 * `identical` means a byte-identical file is already in `Paths/`, so installing
 * it is a no-op. `renamed` means a *different* file holds that name and this one
 * took a suffixed variant instead — never an overwrite.
 */
export type OssmFileStatus = 'new' | 'identical' | 'renamed'

export type OssmCandidate = {
  videoId: string
  /** Source filename as it exists in the library, e.g. `Hard.bx`. */
  sourceFile: string
  /** Absolute path under `videos/`. Server-side only. */
  sourcePath: string
  /** Final name inside `Paths/`, e.g. `hopeless-hard.bx`. */
  name: string
}

export type OssmPlannedFile = OssmCandidate & {
  status: OssmFileStatus
  bytes: number
}

/**
 * A planned file as the browser sees it. `sourcePath` is dropped: an absolute
 * path on the server is no use to the client, and the manager API is reachable
 * across the LAN.
 */
export type OssmPlanFile = Omit<OssmPlannedFile, 'sourcePath'>

export type OssmTargetSource =
  | 'env' // OSSM_SAUCE_DIR
  | 'config' // config.json → ossmSauceDir
  | 'detected' // a Documents candidate that already holds an OSSM Sauce install
  | 'default' // best-guess Documents dir, nothing installed there yet
  | 'unresolved'

export type OssmTarget = {
  /** Absolute path to the `OSSM Sauce` folder itself, or null when unresolved. */
  dir: string | null
  source: OssmTargetSource
  /** True when `UserSettings.cfg` or `Paths/` is already there — i.e. a real install. */
  exists: boolean
  platform: NodeJS.Platform | string
}

export type OssmPlan = {
  target: OssmTarget
  /**
   * False when the request did not come from the machine running the server —
   * installing would write to the *server's* Documents folder, not the
   * viewer's. A guard against a confusing outcome, not a security boundary.
   */
  canInstall: boolean
  files: OssmPlanFile[]
  playlist: OssmPlaylist | null
  warnings: string[]
}

/**
 * The same plan before it is serialised: the install route still needs the
 * source paths to copy from.
 */
export type OssmServerPlan = Omit<OssmPlan, 'files'> & { files: OssmPlannedFile[] }

export type OssmInstallResult = {
  dir: string
  written: string[]
  /** Names skipped because an identical file was already there. */
  skipped: string[]
  playlist: string | null
  warnings: string[]
}

/* -------------------------------------------------------------------------- */
/* posting straight to the app                                                */
/* -------------------------------------------------------------------------- */

/**
 * One file as the browser has to hand it to the app: the name we ask for and
 * the bytes, because the browser is where the request has to come *from* (the
 * phone can reach the app's port; the Node server may be a different machine)
 * and the library is where the bytes *are*.
 *
 * No `sourcePath`: same rule as `OssmPlanFile`. An absolute path on the server
 * is no use here and the manager API is reachable across the LAN.
 */
export type OssmPayloadFile = {
  videoId: string
  sourceFile: string
  /** Name we ask `/load_path` to store it as — see `OssmSendFile.stored`. */
  name: string
  /** Raw size, before base64. */
  bytes: number
  /** Standard base64, no data: prefix — the `data_b64` field of `/load_path`. */
  dataB64: string
}

/**
 * The export set with content attached, for the send-to-app route. Deliberately
 * planned like the zip download rather than like an install: what is already in
 * the app's `Paths/` is the app's business, and the server may not even be
 * looking at the same machine's folder.
 */
export type OssmPayload = {
  files: OssmPayloadFile[]
  /** The `.bxpl` to post after the files land, or null for a paths-only send. */
  playlist: OssmPlaylist | null
  warnings: string[]
}

/** What `/load_path` did with one file. */
export type OssmSendFile = {
  /** The name we posted. */
  requested: string
  /**
   * The name the app is actually holding it under, or null if it never landed.
   * The app never overwrites: identical bytes reuse the stored file, and a name
   * held by *different* bytes becomes `foo (2).bx`. The playlist has to point at
   * this, not at `requested`.
   */
  stored: string | null
  /** True when the app recognised the bytes and kept the file it already had. */
  reused: boolean
  /** Populated only when `stored` is null. */
  error: string | null
}

/**
 * `sent` — the app loaded it. `conflict` — 409: the queue is not empty and we
 * did not ask to replace it, which is the app refusing to discard something
 * that may be playing. `none` — a paths-only send, so there was no `.bxpl`.
 */
export type OssmPlaylistOutcome = 'sent' | 'conflict' | 'failed' | 'none' | 'skipped'

export type OssmPlaylistResult = {
  outcome: OssmPlaylistOutcome
  /** Entries the app took, and how many of them resolved to no path file. */
  entries: number
  missing: number
  error: string | null
}

export type OssmSendResult = {
  /** The base URL every request went to, so a failure can name it. */
  url: string
  files: OssmSendFile[]
  /**
   * The `.bxpl` as actually posted — entry paths substituted for the names the
   * app answered with, and dropped entries already removed. Null for a
   * paths-only send. Hand this straight back to `sendOssmPlaylist` to retry a
   * 409; rebuilding it from `files` would lose the flags.
   */
  sentPlaylist: OssmPlaylist | null
  /** Paths left out because their file never stored — they would only be `missing`. */
  droppedPaths: string[]
  playlist: OssmPlaylistResult
  warnings: string[]
}
