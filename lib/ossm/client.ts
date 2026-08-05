/**
 * Browser-side calls for the OSSM Sauce export.
 *
 * Four endpoints, one request shape (see `./types`): dry-run the install, commit
 * it, download the same content as a zip, or fetch it with the bytes inline so
 * the browser can post it to the app itself (`./app`).
 */

import { MANAGER_API } from '@/lib/manager-client'
import type { OssmInstallResult, OssmPayload, OssmPlan, OssmRequest } from './types'

const OSSM_API = `${MANAGER_API}/ossm`

async function postJson<T>(url: string, body: OssmRequest): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  const data = (await res.json()) as T & { error?: string }
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

/** What an install *would* do: target folder, per-file status, `.bxpl` contents. */
export function planOssmExport(body: OssmRequest): Promise<OssmPlan> {
  return postJson<OssmPlan>(`${OSSM_API}/plan`, body)
}

export function installOssmExport(body: OssmRequest): Promise<OssmInstallResult> {
  return postJson<OssmInstallResult>(`${OSSM_API}/install`, body)
}

/**
 * The export set with each file base64-encoded, to hand to `sendOssmPayload`.
 *
 * The bytes come here rather than being forwarded server-side on purpose: the
 * app has to be reached from *this device*, which is the whole reason this route
 * exists. Path data is tens of KB a file, so a JSON round trip is cheap.
 */
export function fetchOssmPayload(body: OssmRequest): Promise<OssmPayload> {
  return postJson<OssmPayload>(`${OSSM_API}/payload`, body)
}

/**
 * Download the bundle as a zip. Held in memory as a blob rather than routed
 * through a token + navigation like the library exporter: path data is a few
 * hundred KB, so there is nothing to stream.
 */
export async function downloadOssmBundle(body: OssmRequest): Promise<void> {
  const res = await fetch(`${OSSM_API}/bundle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const data = (await res.json()) as { error?: string }
      if (data.error) message = data.error
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message)
  }

  const disposition = res.headers.get('Content-Disposition') || ''
  const match = disposition.match(/filename="([^"]+)"/)
  const filename = match ? match[1] : 'ossm-bundle.zip'

  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking synchronously can cancel the download in Safari — the mac build
  // is a target, so give it a beat.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Human-readable one-liner for a plan, used in the confirm step. */
export function summarizePlan(plan: OssmPlan): string {
  const counts = { new: 0, identical: 0, renamed: 0 }
  for (const f of plan.files) counts[f.status] += 1
  const parts = [`${counts.new} new`]
  if (counts.identical) parts.push(`${counts.identical} already there`)
  if (counts.renamed) parts.push(`${counts.renamed} renamed to avoid a clash`)
  return parts.join(', ')
}
