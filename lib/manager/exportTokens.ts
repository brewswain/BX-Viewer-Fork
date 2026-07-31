import crypto from 'node:crypto'

export interface ExportJob {
  videos: string[]
  playlists: string[]
  filename: string
}

/**
 * One-use export tokens, matching manager.py's in-memory `_export_tokens` dict.
 * The token exists only so the browser can be sent to a plain GET URL that its
 * native download manager can handle; it is consumed on first use.
 *
 * Stashed on globalThis for the same reason the version counter is: dev-mode
 * module reloads would otherwise invalidate tokens mid-flight.
 */
const KEY = '__bxExportTokens'

type TokenGlobal = typeof globalThis & { [KEY]?: Map<string, ExportJob> }

function store(): Map<string, ExportJob> {
  const g = globalThis as TokenGlobal
  if (!g[KEY]) g[KEY] = new Map<string, ExportJob>()
  return g[KEY]!
}

/** `secrets.token_urlsafe(32)` — 32 random bytes, URL-safe base64. */
export function createExportToken(job: ExportJob): string {
  const token = crypto.randomBytes(32).toString('base64url')
  store().set(token, job)
  return token
}

export function consumeExportToken(token: string): ExportJob | null {
  const jobs = store()
  const job = jobs.get(token)
  if (!job) return null
  jobs.delete(token)
  return job
}
