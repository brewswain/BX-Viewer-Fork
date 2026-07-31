import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { jsonError, jsonResponse } from '@/lib/json'
import { errorMessage } from '@/lib/manager/endpoints'
import { makeTempDir, rmrf } from '@/lib/manager/fsx'
import { InvalidZipError, runImport } from '@/lib/manager/importZip'
import { ROOT } from '@/lib/paths'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 3600

/**
 * Package import. The client POSTs the raw .zip as the request body.
 *
 * The upload lands in a staging directory under the repo root — the same volume
 * as videos/ and playlists/ — so each extracted package folder is moved into
 * place with a rename rather than a cross-volume copy.
 */
export async function POST(request: Request) {
  const body = request.body
  if (!body) return jsonError('Empty request body', 400)

  const stagingRoot = await makeTempDir(ROOT, '.tmp-import-')
  try {
    const zipPath = path.join(stagingRoot, 'upload.zip')
    await pipeline(
      Readable.fromWeb(body as unknown as NodeWebReadableStream<Uint8Array>),
      createWriteStream(zipPath),
    )

    const { size } = await fs.stat(zipPath)
    if (size === 0) return jsonError('Empty request body', 400)

    return jsonResponse(await runImport(zipPath, stagingRoot))
  } catch (e) {
    if (e instanceof InvalidZipError) return jsonError(e.message, 400)
    return jsonError(errorMessage(e), 500)
  } finally {
    await rmrf(stagingRoot)
  }
}
