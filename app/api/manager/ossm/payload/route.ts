import { jsonError, jsonResponse } from '@/lib/json'
import { guard } from '@/lib/manager/endpoints'
import { buildPayload, OssmRequestError, parseOssmRequest } from '@/lib/ossm/bundle'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The export set with each file's content base64-encoded, so the *browser* can
 * post it to the OSSM Sauce app itself (`lib/ossm/app.ts`).
 *
 * Why the bytes come back to the client instead of the server forwarding them:
 * the app has to be reached from the device looking at this page. A phone on the
 * LAN can reach the app's port; the Node server might be a different machine
 * entirely, which is exactly the confusion that makes `/install` refuse
 * off-loopback. So this route reads the library — the one thing only the server
 * can do — and stops there.
 *
 * No loopback guard for the same reason, and no filesystem paths in the
 * response: `toWirePlan` drops `sourcePath` and so does `buildPayload`.
 */
export async function POST(request: Request) {
  return guard(async () => {
    const parsed = parseOssmRequest(await request.text())
    if (!parsed.ok) return jsonError(parsed.error, 400)

    try {
      const payload = await buildPayload(parsed.request)
      if (payload.files.length === 0) {
        return jsonError('None of the selected paths could be read', 404)
      }
      return jsonResponse(payload)
    } catch (e) {
      if (e instanceof OssmRequestError) return jsonError(e.message, 400)
      throw e
    }
  })
}
