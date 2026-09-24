import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { serveFile } from './serveFile'

// Kept in the repo, not %TEMP%: see .gitignore on why fixtures live here.
const DIR = path.join(process.cwd(), `.tmp-test-servefile-${process.pid}`)
const FILE = path.join(DIR, 'clip.mp4')
// Bigger than one read chunk, and not a multiple of it.
const DATA = new Uint8Array(1024 * 1024 + 12345).map((_, i) => (i * 31) % 251)

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(FILE, DATA)
})
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }))

const get = (headers: Record<string, string> = {}, signal?: AbortSignal) =>
  serveFile(FILE, new Request('http://x/clip.mp4', { headers, signal }))

describe('serveFile', () => {
  it('sends the whole file', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(DATA)
  })

  it('sends a range byte-exact, across a chunk boundary', async () => {
    const start = 500_000
    const end = 1_050_000
    const res = await get({ range: `bytes=${start}-${end}` })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-length')).toBe(String(end - start + 1))
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(DATA.slice(start, end + 1))
  })

  it('survives the client hanging up mid-stream', async () => {
    const ac = new AbortController()
    const res = await get({ range: 'bytes=0-' }, ac.signal)
    const reader = res.body!.getReader()
    await reader.read()
    ac.abort()
    await reader.cancel()
    // Give any late read a chance to land on the closed stream.
    await new Promise((r) => setTimeout(r, 50))
  })

  it('answers an already-aborted request without opening the file', async () => {
    const ac = new AbortController()
    ac.abort()
    const res = await get({}, ac.signal)
    expect((await res.arrayBuffer()).byteLength).toBe(0)
  })
})
