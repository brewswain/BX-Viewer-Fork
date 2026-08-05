/**
 * `bun test lib/ossm` — no test dependency, bun's runner is built in.
 *
 * Two things here have no visible failure mode. The `bxFile` allowlist is the
 * only check standing between the export and an arbitrary file read, and a
 * `.bxpl` line built from the wrong name still loads — it just plays another
 * video's path.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ROOT } from '@/lib/paths'
import {
  buildCandidates,
  buildPayload,
  bxplLinesFor,
  ossmBundleFilename,
  OssmRequestError,
} from './bundle'
import type { OssmItem, OssmPlannedFile } from './types'

let base = ''

/**
 * Only `meta.json` is written: `buildCandidates` never opens the path file, and
 * every file created here costs ~60ms on this volume.
 */
async function video(id: string, meta: unknown): Promise<void> {
  const dir = path.join(base, id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8')
}

beforeAll(async () => {
  // In-repo rather than %TEMP%: that is on the system volume, where creating a
  // file costs ~0.5s here and blows bun's 5s hook timeout.
  base = await fs.mkdtemp(path.join(ROOT, '.tmp-test-ossm-'))
  await video('Hope', { bxFiles: [{ label: 'Default', file: 'Hope.bx' }] })
  await video('Hopeless', {
    bxFiles: [
      { label: 'Hard', file: 'Hard.bx' },
      { label: 'Easy - Things&Stuff', file: 'Easy.bx' },
    ],
  })
  await video('Legacy', { bxFile: 'Legacy.bx' })
  await video('Empty', { title: 'no paths' })
  // Slugifies to `hope` as well, so it collides with the Hope video.
  await video('Hope!', { bxFiles: [{ label: 'Default', file: 'Other.bx' }] })
  await video('Escapee', { bxFiles: [{ label: 'Default', file: '../Hope/Hope.bx' }] })
  // `buildPayload` is the only thing here that opens the path files themselves.
  // `Hopeless/Easy.bx` is deliberately left absent, to exercise the drop.
  await fs.writeFile(path.join(base, 'Hope', 'Hope.bx'), 'hope-bytes', 'utf8')
  await fs.writeFile(path.join(base, 'Hopeless', 'Hard.bx'), 'hard-bytes', 'utf8')
})

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

const item = (videoId: string, bxFile: string): OssmItem => ({ videoId, bxFile })

describe('buildCandidates naming', () => {
  test('single-variant videos get the bare slug, multi-variant get the suffix', async () => {
    const { candidates, warnings } = await buildCandidates(
      [item('Hope', 'Hope.bx'), item('Hopeless', 'Hard.bx'), item('Hopeless', 'Easy.bx')],
      base,
    )
    expect(warnings).toEqual([])
    expect(candidates.map((c) => c.name)).toEqual([
      'hope.bx',
      'hopeless-hard.bx',
      'hopeless-easy.bx',
    ])
    expect(candidates[0].sourcePath).toBe(path.join(base, 'Hope', 'Hope.bx'))
  })

  test('honours the legacy single bxFile', async () => {
    const { candidates } = await buildCandidates([item('Legacy', 'Legacy.bx')], base)
    expect(candidates.map((c) => c.name)).toEqual(['legacy.bx'])
  })

  test('preserves request order', async () => {
    const { candidates } = await buildCandidates(
      [item('Legacy', 'Legacy.bx'), item('Hope', 'Hope.bx'), item('Hopeless', 'Easy.bx')],
      base,
    )
    expect(candidates.map((c) => c.videoId)).toEqual(['Legacy', 'Hope', 'Hopeless'])
  })

  test('the same path twice is one file', async () => {
    const { candidates, warnings } = await buildCandidates(
      [item('Hope', 'Hope.bx'), item('Hopeless', 'Hard.bx'), item('Hope', 'Hope.bx')],
      base,
    )
    expect(candidates).toHaveLength(2)
    expect(warnings).toEqual([])
  })

  test('two videos claiming one name are disambiguated, not collapsed', async () => {
    const { candidates, warnings } = await buildCandidates(
      [item('Hope', 'Hope.bx'), item('Hope!', 'Other.bx')],
      base,
    )
    expect(candidates.map((c) => c.name)).toEqual(['hope.bx', 'hope-2.bx'])
    expect(candidates[1].sourcePath).toBe(path.join(base, 'Hope!', 'Other.bx'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('hope-2.bx')
  })
})

describe('buildCandidates validation', () => {
  test('rejects a bxFile the video does not list', async () => {
    // The allowlist, i.e. the arbitrary-read guard.
    await expect(buildCandidates([item('Hope', 'Hard.bx')], base)).rejects.toThrow(OssmRequestError)
    await expect(buildCandidates([item('Hope', '../../config.json')], base)).rejects.toThrow(
      /not one of its path files/,
    )
  })

  test('rejects an id that is not a plain folder name', async () => {
    for (const bad of ['../Hope', 'a/b', '..', '']) {
      await expect(buildCandidates([item(bad, 'Hope.bx')], base)).rejects.toThrow(OssmRequestError)
    }
  })

  test('a missing meta.json or a video with no path is a warning, not a throw', async () => {
    const { candidates, warnings } = await buildCandidates(
      [item('Nope', 'Nope.bx'), item('Empty', 'Empty.bx'), item('Hope', 'Hope.bx')],
      base,
    )
    expect(candidates.map((c) => c.videoId)).toEqual(['Hope'])
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('Nope')
    expect(warnings[1]).toContain('Empty')
  })

  test('a listed path that escapes its folder is skipped', async () => {
    const { candidates, warnings } = await buildCandidates(
      [item('Escapee', '../Hope/Hope.bx')],
      base,
    )
    expect(candidates).toEqual([])
    expect(warnings[0]).toContain('escapes')
  })
})

describe('bxplLinesFor', () => {
  const planned = (
    videoId: string,
    sourceFile: string,
    name: string,
    status: OssmPlannedFile['status'] = 'new',
  ): OssmPlannedFile => ({
    videoId,
    sourceFile,
    sourcePath: `/library/${videoId}/${sourceFile}`,
    name,
    status,
    bytes: 1,
  })

  test('one line per item, in request order', () => {
    const files = [
      planned('Hope', 'Hope.bx', 'hope.bx'),
      planned('Hopeless', 'Hard.bx', 'hopeless-hard.bx'),
    ]
    const items = [item('Hopeless', 'Hard.bx'), item('Hope', 'Hope.bx'), item('Hopeless', 'Hard.bx')]
    expect(bxplLinesFor(files, items)).toEqual(['hopeless-hard.bx', 'hope.bx', 'hopeless-hard.bx'])
  })

  test('a renamed file is referenced by its suffixed name', () => {
    const files = [planned('Hope', 'Hope.bx', 'hope-9f8e7d6c.bx', 'renamed')]
    expect(bxplLinesFor(files, [item('Hope', 'Hope.bx')])).toEqual(['hope-9f8e7d6c.bx'])
  })

  test('an identical file is referenced by the name already in Paths/', () => {
    const files = [planned('Hope', 'Hope.bx', 'Hope.bx', 'identical')]
    expect(bxplLinesFor(files, [item('Hope', 'Hope.bx')])).toEqual(['Hope.bx'])
  })

  test('an item with no planned file contributes no line', () => {
    const files = [planned('Hope', 'Hope.bx', 'hope.bx')]
    expect(bxplLinesFor(files, [item('Nope', 'Nope.bx'), item('Hope', 'Hope.bx')])).toEqual([
      'hope.bx',
    ])
  })
})

describe('buildPayload', () => {
  test('carries the bytes under the exported name, and no server paths', async () => {
    const payload = await buildPayload(
      { items: [item('Hope', 'Hope.bx'), item('Hopeless', 'Hard.bx')], playlistTitle: 'Set' },
      base,
    )
    expect(payload.files.map((f) => f.name)).toEqual(['hope.bx', 'hopeless-hard.bx'])
    expect(Buffer.from(payload.files[0].dataB64, 'base64').toString('utf8')).toBe('hope-bytes')
    expect(payload.files[0].bytes).toBe('hope-bytes'.length)
    // `commit 32eb84a` took absolute server paths out of the plan response; they
    // must not come back in through this one.
    expect(JSON.stringify(payload)).not.toContain(base)
    for (const f of payload.files) expect(f).not.toHaveProperty('sourcePath')
  })

  test('the playlist lines match the names the files are posted under', async () => {
    const payload = await buildPayload(
      {
        items: [item('Hopeless', 'Hard.bx'), item('Hope', 'Hope.bx'), item('Hopeless', 'Hard.bx')],
        playlistTitle: 'Set',
      },
      base,
    )
    expect(payload.playlist).toEqual({
      name: 'Set',
      lines: ['hopeless-hard.bx', 'hope.bx', 'hopeless-hard.bx'],
    })
  })

  test('an unreadable path is a warning and contributes no line', async () => {
    const payload = await buildPayload(
      { items: [item('Hopeless', 'Easy.bx'), item('Hope', 'Hope.bx')], playlistTitle: 'Set' },
      base,
    )
    expect(payload.files.map((f) => f.name)).toEqual(['hope.bx'])
    expect(payload.playlist?.lines).toEqual(['hope.bx'])
    expect(payload.warnings).toHaveLength(1)
    expect(payload.warnings[0]).toContain('Easy.bx')
  })

  test('no playlist title means no .bxpl', async () => {
    const payload = await buildPayload({ items: [item('Hope', 'Hope.bx')] }, base)
    expect(payload.playlist).toBeNull()
  })
})

describe('ossmBundleFilename', () => {
  test('sanitizes and suffixes', () => {
    expect(ossmBundleFilename('BX Lite Vol. 5')).toBe('BX Lite Vol. 5-ossm.zip')
    expect(ossmBundleFilename('a/b:c')).toBe('a_b_c-ossm.zip')
    expect(ossmBundleFilename('already.zip')).toBe('already-ossm.zip')
    expect(ossmBundleFilename(null)).toBe('paths-ossm.zip')
    expect(ossmBundleFilename('  ')).toBe('paths-ossm.zip')
  })
})
