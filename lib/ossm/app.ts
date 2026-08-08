/**
 * The third export route: the browser posts straight to the OSSM Sauce app.
 *
 * Download hands the user a zip. Install writes into the filesystem of whatever
 * machine runs *this viewer's* Node server, which is why it is refused
 * off-loopback (`isLoopbackRequest`, `lib/ossm/bundle.ts`) — a phone tapping it
 * would fill the server's Documents folder, not its own. This route posts the
 * file *content* to the app's own HTTP server and lets the app do the write, and
 * that fixes both of Install's limits at once:
 *
 *  - it works from anywhere that can reach the app's port, not just loopback;
 *  - the app resolves its own storage folder, so a `custom_paths_dir`
 *    (`ossm_sauce.gd:2326-2333`, which redirects `Paths/` and only `Paths/`) is
 *    honoured for free. Our own resolver has no concept of that setting.
 *
 * Every request here goes out from the *page*. Routing it through Node would
 * put us straight back on "whose machine is this?". The app is built for it:
 * the listener binds `0.0.0.0`, `OPTIONS` is answered 200, and every response
 * carries `Access-Control-Allow-Origin: *` (`mcp_command_server.gd:49,148,376`).
 *
 * The order is store-everything-then-queue-once: one `/load_path` per file with
 * `queue: false`, then a single `/load_playlist`. Queueing per file would leave
 * a half-built queue behind any failure, and the playlist is what puts the
 * entries in order anyway.
 */

import { bxplBody } from './naming'
import type {
  OssmEntry,
  OssmPayload,
  OssmPayloadFile,
  OssmPlaylist,
  OssmPlaylistResult,
  OssmSendFile,
  OssmSendResult,
} from './types'

/** The app's default MCP port — the same one device output uses. */
export const OSSM_APP_PORT = 8081

/** `MAX_REQUEST_BYTES` in `mcp_command_server.gd:22`. Per request, so per file. */
const MAX_REQUEST_BYTES = 16 * 1024 * 1024

const FILE_TIMEOUT_MS = 20_000
const STATUS_TIMEOUT_MS = 3_000

/**
 * Where the app most likely is, given where this page came from.
 *
 * The viewer is normally served on a LAN port, and the app usually runs on the
 * same machine as the browser looking at it — but "the same machine as the
 * browser" is not something the server can know, which is why this is decided
 * here and stored per device. `http://192.168.1.5:3000` therefore guesses
 * `http://192.168.1.5:8081`, and that guess is right whenever the viewer and the
 * app are on one box, phone or desktop.
 */
export function defaultOssmAppUrl(): string {
  if (typeof window === 'undefined') return `http://127.0.0.1:${OSSM_APP_PORT}`
  const host = window.location.hostname || '127.0.0.1'
  return `http://${host}:${OSSM_APP_PORT}`
}

/**
 * Tidy a hand-typed address into an origin. A bare host means the app's port,
 * not port 80 — `192.168.1.5` is a far likelier thing to type than a URL.
 */
export function normalizeOssmAppUrl(raw: string): string {
  const trimmed = (raw || '').trim()
  if (!trimmed) return ''
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (!url.port) url.port = String(OSSM_APP_PORT)
    // Origin, not href: the server matches the request target exactly, so any
    // path a user pasted would only turn every request into a 404.
    return url.origin
  } catch {
    return withScheme.replace(/\/+$/, '')
  }
}

/** Stored override, else the guess from this page's own hostname. */
export function resolveOssmAppUrl(stored: string | null | undefined): string {
  return normalizeOssmAppUrl(stored || '') || defaultOssmAppUrl()
}

/* -------------------------------------------------------------------------- */
/* transport                                                                  */
/* -------------------------------------------------------------------------- */

type PostOk = { ok: true; data: Record<string, unknown> }
type PostFail = {
  ok: false
  /** 0 for a failure that never got an HTTP answer (unreachable, CORS, aborted). */
  status: number
  error: string
}
type PostResult = PostOk | PostFail

function timeoutSignal(ms: number): AbortSignal | undefined {
  // Matches `lib/device/ossmDirect.ts`: available everywhere this app supports,
  // but not worth crashing an older WebView or the test runner over.
  if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
    return AbortSignal.timeout(ms)
  }
  return undefined
}

/**
 * A failed `fetch` to another origin tells the page nothing about why — app not
 * running, wrong address, wrong network and a CORS rejection are one and the
 * same `TypeError`. So say all of it, and name the address it tried; "failed"
 * on its own is useless on the first run, which is exactly when this fails.
 */
export function describeUnreachable(url: string): string {
  const mixed =
    typeof window !== 'undefined' && window.location.protocol === 'https:'
      ? ' This page is served over HTTPS, and browsers block plain-HTTP requests from it — the app has no HTTPS to offer, so this route needs the viewer over HTTP.'
      : ''
  return (
    `Could not reach OSSM Sauce at ${url}. Check that the app is running with its ` +
    `MCP server started (Bridge Settings → Bridge Mode: MCP → Enable), that the ` +
    `address and port are right, and that this device can reach that machine.` +
    mixed
  )
}

async function post(url: string, path: string, body: unknown, timeoutMs: number): Promise<PostResult> {
  let res: Response
  try {
    res = await fetch(url + path, {
      method: 'POST',
      // Deliberately not application/json, as in `lib/device/ossmDirect.ts`:
      // text/plain keeps this a simple request, so no preflight round-trip per
      // file. The handler only JSON-parses the body and never reads the type.
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: timeoutSignal(timeoutMs),
    })
  } catch {
    return { ok: false, status: 0, error: describeUnreachable(url) }
  }

  const text = await res.text().catch(() => '')
  let data: Record<string, unknown> = {}
  try {
    const parsed: unknown = text ? JSON.parse(text) : {}
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>
  } catch {
    /* the app answers JSON, but an error body is not worth throwing over */
  }

  if (!res.ok) {
    const message = typeof data.error === 'string' && data.error ? data.error : `HTTP ${res.status}`
    return { ok: false, status: res.status, error: message }
  }
  return { ok: true, data }
}

export type OssmAppStatus = {
  websocket_listening?: boolean
  connected_clients?: number
  ossm_connected?: boolean
  server_started?: boolean
  has_mcp_server?: boolean
}

/**
 * Is the app there? `/status` is the right probe: it is the one endpoint that
 * takes no body, changes nothing and answers 200 whenever the server is up
 * (`mcp_command_server.gd:344`), so it distinguishes "wrong address" from
 * "address fine, request rejected" before a send is attempted.
 */
export async function checkOssmApp(
  rawUrl: string,
): Promise<{ ok: true; url: string; status: OssmAppStatus } | { ok: false; url: string; error: string }> {
  const url = resolveOssmAppUrl(rawUrl)
  const res = await post(url, '/status', {}, STATUS_TIMEOUT_MS)
  if (!res.ok) return { ok: false, url, error: res.error }
  return { ok: true, url, status: res.data as OssmAppStatus }
}

/* -------------------------------------------------------------------------- */
/* sending                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Point the `.bxpl` entries at the names the app is actually holding.
 *
 * The app never overwrites: identical bytes reuse the file already stored, and a
 * name held by different bytes is taken as `foo (2).bx` (`path_import.gd`). So
 * the name we asked for is not necessarily the name it has, and a playlist built
 * from what we *sent* can point at a different video's path. An entry whose file
 * never stored is dropped rather than left in — the app would only count it as
 * `missing`, and a dead entry in the queue is worse than a shorter playlist.
 *
 * Only `path` is rewritten. Everything else on an entry describes how to *play*
 * it, not which file it is, and survives the substitution untouched — a renamed
 * file keeps its repeat setting and its video offset.
 *
 * Pure, and the only part of this module worth testing.
 */
export function applyStoredNames(
  entries: readonly OssmEntry[],
  files: readonly OssmSendFile[],
): { entries: OssmEntry[]; dropped: string[] } {
  const stored = new Map<string, string | null>()
  for (const f of files) stored.set(f.requested, f.stored)

  const out: OssmEntry[] = []
  const dropped: string[] = []
  for (const entry of entries) {
    if (!stored.has(entry.path)) {
      // No outcome for this name at all: it did not come from this send, so
      // leave it alone rather than silently deleting an entry we don't own.
      out.push(entry)
      continue
    }
    const name = stored.get(entry.path)
    if (name) out.push({ ...entry, path: name })
    else dropped.push(entry.path)
  }
  return { entries: out, dropped }
}

/** The JSON `/load_path` request for one file, so its size can be checked first. */
function loadPathBody(file: OssmPayloadFile) {
  return { name: file.name, data_b64: file.dataB64, queue: false }
}

/**
 * Post one `.bxpl` body. Split out from `sendOssmPayload` so a 409 can be
 * retried after asking the user, without re-uploading every file to get there.
 *
 * `replace` is left off the first attempt on purpose: the app refuses with 409
 * when the queue is not empty and we did not say we meant to discard it, and
 * that refusal is the only chance the user gets to object — an HTTP caller
 * cannot be prompted down the connection it is waiting on
 * (`mcp_command_server.gd:325-333`).
 */
export async function sendOssmPlaylist(
  rawUrl: string,
  playlist: OssmPlaylist,
  replace: boolean,
): Promise<OssmPlaylistResult> {
  const url = resolveOssmAppUrl(rawUrl)
  const body: Record<string, unknown> = { text: bxplBody(playlist) }
  if (replace) body.replace = true

  const res = await post(url, '/load_playlist', body, FILE_TIMEOUT_MS)
  if (!res.ok) {
    return {
      outcome: res.status === 409 ? 'conflict' : 'failed',
      entries: 0,
      missing: 0,
      error: res.error,
    }
  }
  return {
    outcome: 'sent',
    entries: typeof res.data.entries === 'number' ? res.data.entries : playlist.entries.length,
    missing: typeof res.data.missing === 'number' ? res.data.missing : 0,
    error: null,
  }
}

/**
 * Store every file, then load the playlist built from the names that came back.
 *
 * Failure is per file wherever it can be: a path the app won't take should not
 * stop the rest, and what actually landed is reported either way. Two answers
 * are global rather than per file and stop the loop — nothing reachable at all,
 * and 503, which means the app has no paths folder yet and so has nowhere to put
 * any of them.
 */
export async function sendOssmPayload(
  payload: OssmPayload,
  rawUrl: string,
  options: { replace?: boolean } = {},
): Promise<OssmSendResult> {
  const url = resolveOssmAppUrl(rawUrl)
  const files: OssmSendFile[] = []
  const warnings = [...payload.warnings]
  let fatal: string | null = null

  for (const file of payload.files) {
    const body = loadPathBody(file)
    // Checked here rather than left to the app: it refuses an oversized request
    // by closing the connection mid-upload, which the browser reports as a bare
    // network error indistinguishable from the app not being there at all.
    const size = JSON.stringify(body).length
    if (size > MAX_REQUEST_BYTES) {
      files.push({
        requested: file.name,
        stored: null,
        reused: false,
        error: `${file.name} is ${(file.bytes / 1024 / 1024).toFixed(1)} MB, over the app's 16 MB per-file limit.`,
      })
      continue
    }

    const res = await post(url, '/load_path', body, FILE_TIMEOUT_MS)
    if (res.ok) {
      const stored = typeof res.data.name === 'string' && res.data.name ? res.data.name : file.name
      files.push({
        requested: file.name,
        stored,
        reused: res.data.reused === true,
        error: null,
      })
      continue
    }

    files.push({
      requested: file.name,
      stored: null,
      reused: false,
      error: describeLoadPathFailure(res.status, res.error, file.name),
    })
    if (res.status === 0 || res.status === 503) {
      fatal = describeLoadPathFailure(res.status, res.error, file.name)
      break
    }
  }

  const { entries, dropped } = applyStoredNames(payload.playlist?.entries ?? [], files)
  if (dropped.length) {
    warnings.push(
      `Left out of the playlist because ${dropped.length === 1 ? 'it' : 'they'} did not store: ${dropped.join(', ')}`,
    )
  }
  if (fatal) warnings.push(fatal)

  // The flags come through untouched: nothing the app said about the *files*
  // bears on what the user asked for shuffle and loop.
  const sentPlaylist: OssmPlaylist | null = payload.playlist
    ? { ...payload.playlist, entries }
    : null

  let playlist: OssmPlaylistResult = { outcome: 'none', entries: 0, missing: 0, error: null }
  if (sentPlaylist) {
    if (fatal || entries.length === 0) {
      playlist = {
        outcome: 'skipped',
        entries: 0,
        missing: 0,
        error: 'No path reached the app, so the playlist was not sent.',
      }
    } else {
      playlist = await sendOssmPlaylist(url, sentPlaylist, options.replace === true)
    }
  }

  return { url, files, sentPlaylist, droppedPaths: dropped, playlist, warnings }
}

/** The app's status codes, said in terms of what the user can do about them. */
function describeLoadPathFailure(status: number, error: string, name: string): string {
  switch (status) {
    case 0:
      return error
    case 413:
      return `${name} is over the app's 16 MB per-file limit.`
    case 422:
      return `${name} was stored but would not load: ${error}`
    case 503:
      return 'OSSM Sauce has no paths folder set up yet — open it once so it can create its library, then try again.'
    default:
      return `${name}: ${error}`
  }
}

/** One line for a finished send, for a toast or a status row. */
export function summarizeSend(result: OssmSendResult): string {
  const stored = result.files.filter((f) => f.stored && !f.reused).length
  const reused = result.files.filter((f) => f.reused).length
  const failed = result.files.filter((f) => !f.stored).length

  const parts: string[] = [`${stored} sent`]
  if (reused) parts.push(`${reused} already there`)
  if (failed) parts.push(`${failed} failed`)
  if (result.playlist.outcome === 'sent') {
    parts.push(`${result.playlist.entries} queued`)
    if (result.playlist.missing) parts.push(`${result.playlist.missing} missing`)
  }
  return parts.join(', ')
}
