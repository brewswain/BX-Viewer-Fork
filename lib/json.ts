import { NextResponse } from 'next/server'
import fs from 'node:fs/promises'

/**
 * Permissive CORS — kept from when the manager lived on a second port — plus
 * no-store so the browser never serves stale manifests.
 */
export function jsonResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Cache-Control': 'no-store',
    },
  })
}

export function jsonError(message: string, status = 400): NextResponse {
  return jsonResponse({ error: message }, status)
}

/** Read + parse a JSON file, returning `fallback` on any failure. */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Write JSON with a 2-space indent, matching the on-disk manifest/meta files. */
export async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
}
