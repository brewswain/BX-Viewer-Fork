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

export type OssmRequest = {
  items: OssmItem[]
  /** Becomes the `.bxpl` filename. Omit for a paths-only export (watch page). */
  playlistTitle?: string | null
  /** Zip filename, download route only. */
  bundleName?: string | null
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
  playlist: { name: string; lines: string[] } | null
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
  /** `.bxpl` name (no extension) and its lines, or null for a paths-only send. */
  playlist: { name: string; lines: string[] } | null
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
  /** Names the `.bxpl` was built from, after substituting what the app answered. */
  playlistLines: string[]
  /** Lines dropped because their file never stored — they would only be `missing`. */
  droppedLines: string[]
  playlist: OssmPlaylistResult
  warnings: string[]
}
