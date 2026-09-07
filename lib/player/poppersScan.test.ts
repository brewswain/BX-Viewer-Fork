import { describe, expect, test, beforeEach, afterAll } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { clearPoppersScanCache, scanPoppersCycles } from './poppersScan'

const CARD = {
  type: 'text',
  layer: 1,
  startFrame: 0,
  endFrame: 60,
  fontSize: 22,
  posX: 50,
  posY: 22,
}

function bx(effects: Array<Record<string, unknown>>) {
  return JSON.stringify({ meta: { version: 2 }, markers: {}, effects })
}

function cycle(n: number) {
  return ['GET READY', 'INHALE', 'SMALL INHALE', 'HOLD', 'LONG HOLD', 'EXHALE'].map(
    (text, i) => ({ ...CARD, id: `bxs-pop${n}-${i}`, text }),
  )
}

let dir = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'popscan-'))
  clearPoppersScanCache()
})

afterAll(async () => {
  // Each test makes its own dir; the tmp root is left alone.
})

describe('scanPoppersCycles', () => {
  test('reports the MAX over a video paths, never the sum', async () => {
    // `sissy-big-toys-synth` is nine paths with cues on one of them.
    await fs.writeFile(path.join(dir, 'a.bx'), bx([...cycle(1), ...cycle(2)]))
    await fs.writeFile(path.join(dir, 'b.bx'), bx([]))
    await fs.writeFile(path.join(dir, 'c.bx'), bx(cycle(1)))
    expect(await scanPoppersCycles(dir, ['a.bx', 'b.bx', 'c.bx'])).toBe(2)
  })

  test('lights on a non-default path too, so a cued video is never invisible', async () => {
    await fs.writeFile(path.join(dir, 'default.bx'), bx([]))
    await fs.writeFile(path.join(dir, 'other.bx'), bx(cycle(1)))
    expect(await scanPoppersCycles(dir, ['default.bx', 'other.bx'])).toBe(1)
  })

  test('an ordinary path is 0, and so is a caption-only one', async () => {
    // `Alunacoz.bx` carries 76 of its own captions and no breath anywhere.
    await fs.writeFile(
      path.join(dir, 'captions.bx'),
      bx([
        { ...CARD, id: 'a1', text: 'Lube up quick' },
        { ...CARD, id: 'a2', text: 'Nice job keeping up with that one' },
      ]),
    )
    await fs.writeFile(path.join(dir, 'plain.bx'), JSON.stringify({ markers: {} }))
    expect(await scanPoppersCycles(dir, ['captions.bx', 'plain.bx'])).toBe(0)
  })

  test('a GET READY section title is not a breath', async () => {
    // LunaPMV.bx's two chapter cards, with no cycle around them.
    await fs.writeFile(
      path.join(dir, 'titles.bx'),
      bx([
        { ...CARD, id: 't1', text: 'GET READY' },
        { ...CARD, id: 't2', text: 'GET READY' },
      ]),
    )
    expect(await scanPoppersCycles(dir, ['titles.bx'])).toBe(0)
  })

  test('a missing file, an unparseable one and an empty list are all 0', async () => {
    await fs.writeFile(path.join(dir, 'broken.bx'), '{"effects": [')
    expect(await scanPoppersCycles(dir, ['gone.bx', 'broken.bx'])).toBe(0)
    expect(await scanPoppersCycles(dir, [])).toBe(0)
  })

  test('a bxFiles entry that escapes the video folder is refused, not read', async () => {
    // meta.json is hand-edited in this library, so `files` is untrusted input.
    const outside = path.join(dir, 'outside.bx')
    await fs.writeFile(outside, bx(cycle(1)))
    const sub = path.join(dir, 'video')
    await fs.mkdir(sub)
    expect(await scanPoppersCycles(sub, ['../outside.bx'])).toBe(0)
  })

  test('the cache invalidates on a rewrite rather than on time', async () => {
    const file = path.join(dir, 'p.bx')
    await fs.writeFile(file, bx([]))
    expect(await scanPoppersCycles(dir, ['p.bx'])).toBe(0)
    // Same path, new content. mtime and size both move, so the next read is real.
    await fs.writeFile(file, bx(cycle(1)))
    expect(await scanPoppersCycles(dir, ['p.bx'])).toBe(1)
  })

  test('the pre-parse EXHALE reject cannot hide a real cycle', async () => {
    // Lowercase, because the detector uppercases before it matches and the
    // string guard has to be at least as permissive as the detector is.
    await fs.writeFile(
      path.join(dir, 'lower.bx'),
      bx([
        { ...CARD, id: 'l1', text: 'inhale' },
        { ...CARD, id: 'l2', text: 'exhale' },
      ]),
    )
    expect(await scanPoppersCycles(dir, ['lower.bx'])).toBe(1)
  })
})
