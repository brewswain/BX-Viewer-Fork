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
  files: OssmPlannedFile[]
  playlist: { name: string; lines: string[] } | null
  warnings: string[]
}

export type OssmInstallResult = {
  dir: string
  written: string[]
  /** Names skipped because an identical file was already there. */
  skipped: string[]
  playlist: string | null
  warnings: string[]
}
