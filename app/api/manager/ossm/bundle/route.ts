import { Readable } from 'node:stream'
import { jsonError } from '@/lib/json'
import { errorMessage } from '@/lib/manager/endpoints'
import {
  buildCandidates,
  buildOssmArchive,
  ossmBundleFilename,
  OssmRequestError,
  parseOssmRequest,
  planForBundle,
  playlistFor,
} from '@/lib/ossm/bundle'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The same export as a zip, for a viewer running on another machine.
 *
 * Deliberately independent of the install target: names are planned without
 * consulting `Paths/`, so this works on a server with no OSSM Sauce install at
 * all and produces the same zip whatever the server happens to have.
 *
 * `guard` is typed to `NextResponse`, so the error mapping is inline here — this
 * route's success case is a raw streaming `Response`.
 */
export async function POST(request: Request) {
  const parsed = parseOssmRequest(await request.text())
  if (!parsed.ok) return jsonError(parsed.error, 400)

  let planned
  try {
    const { candidates } = await buildCandidates(parsed.request.items)
    planned = await planForBundle(candidates)
  } catch (e) {
    if (e instanceof OssmRequestError) return jsonError(e.message, 400)
    return jsonError(errorMessage(e), 500)
  }
  if (planned.length === 0) return jsonError('None of the selected paths could be read', 404)

  const filename = ossmBundleFilename(parsed.request.bundleName || parsed.request.playlistTitle)
  const archive = buildOssmArchive(planned, playlistFor(parsed.request, planned))
  const body = Readable.toWeb(archive) as unknown as ReadableStream<Uint8Array>

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      // `lib/ossm/client.ts` parses the download name out of this header, so it
      // has to be present and quoted.
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  })
}
