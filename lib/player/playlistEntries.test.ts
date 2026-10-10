/**
 * The playlist entry rule: one video may repeat only on a different path, and
 * per-track state follows the entry, not the video.
 */

import { describe, expect, test } from 'bun:test'
import { cycleRowLoop, EMPTY_PLAYLIST_PREFS, rowLoopMode } from './playback'
import {
  dedupeEntries,
  describeDuplicates,
  entryEffectiveBx,
  findDuplicateEntries,
  nextUnusedBx,
  trackKeys,
} from './playlistEntries'

const ladder = [
  { id: 'hard-to-not-cum', bxFile: 'easy.bx' },
  { id: 'hard-to-not-cum', bxFile: 'moderate.bx' },
  { id: 'hard-to-not-cum', bxFile: 'hard.bx' },
  { id: 'hard-to-not-cum', bxFile: 'extreme.bx' },
]
const defaults = (id: string) => (id === 'hard-to-not-cum' ? 'easy.bx' : null)

describe('findDuplicateEntries', () => {
  test('a ladder of one video on four different paths is allowed', () => {
    expect(findDuplicateEntries(ladder)).toEqual([])
    expect(findDuplicateEntries(ladder, defaults)).toEqual([])
  })

  test('the same video on the same path twice is refused', () => {
    const dups = findDuplicateEntries([...ladder, { id: 'hard-to-not-cum', bxFile: 'hard.bx' }])
    expect(dups).toEqual([
      { index: 4, firstIndex: 2, videoId: 'hard-to-not-cum', bxFile: 'hard.bx' },
    ])
    expect(describeDuplicates(dups)).toContain('#5 repeats #3')
  })

  test('two unpinned entries of one video are both the default, so a repeat', () => {
    expect(findDuplicateEntries(['a', 'b', 'a']).map((d) => d.index)).toEqual([2])
  })

  test('an unpinned entry collides with one pinning the default once defaults resolve', () => {
    const entries = ['hard-to-not-cum', { id: 'hard-to-not-cum', bxFile: 'easy.bx' }]
    expect(findDuplicateEntries(entries)).toEqual([])
    expect(findDuplicateEntries(entries, defaults).map((d) => d.index)).toEqual([1])
    // ...but unpinned plus a different pin is a legal two-rung ladder.
    expect(
      findDuplicateEntries(['hard-to-not-cum', { id: 'hard-to-not-cum', bxFile: 'hard.bx' }], defaults),
    ).toEqual([])
  })

  test('videoId is read as well as id', () => {
    expect(entryEffectiveBx({ videoId: 'x', bxFile: 'p.bx' })).toBe('p.bx')
    expect(findDuplicateEntries([{ videoId: 'x' }, 'x']).length).toBe(1)
  })
})

describe('dedupeEntries', () => {
  test('folds exact repeats and keeps a repeat on another path', () => {
    const queue = ['a', { id: 'a', bxFile: 'hard.bx' }, 'a', { id: 'a', bxFile: 'hard.bx' }, 'b']
    expect(dedupeEntries(queue)).toEqual(['a', { id: 'a', bxFile: 'hard.bx' }, 'b'])
  })
})

describe('nextUnusedBx', () => {
  test('hands out the first path no entry of the video uses yet', () => {
    const files = ['easy.bx', 'moderate.bx', 'hard.bx']
    expect(nextUnusedBx(files, ['easy.bx'])).toBe('moderate.bx')
    expect(nextUnusedBx(files, ['moderate.bx', 'easy.bx'])).toBe('hard.bx')
    expect(nextUnusedBx(files, files)).toBeNull()
  })
})

describe('trackKeys', () => {
  test('a video listed once keys by its bare id, so saved prefs still apply', () => {
    expect(
      trackKeys([
        { videoId: 'a', bxFile: 'a.bx' },
        { videoId: 'b', bxFile: null },
      ]),
    ).toEqual(['a', 'b'])
  })

  test('a repeated video keys each entry by its path', () => {
    const keys = trackKeys(ladder.map((e) => ({ videoId: e.id, bxFile: e.bxFile })))
    expect(new Set(keys).size).toBe(4)
    expect(keys[0]).toBe('hard-to-not-cum#easy.bx')
  })

  test('a hand-edited exact repeat still gets distinct keys', () => {
    const keys = trackKeys([
      { videoId: 'a', bxFile: 'x.bx' },
      { videoId: 'a', bxFile: 'x.bx' },
    ])
    expect(keys[0]).not.toBe(keys[1])
  })

  test('repeat on one rung of a ladder leaves the other rungs alone', () => {
    // Keyed by folder, this used to mark all four rungs at once.
    const keys = trackKeys(ladder.map((e) => ({ videoId: e.id, bxFile: e.bxFile })))
    const prefs = cycleRowLoop({ ...EMPTY_PLAYLIST_PREFS, tracks: {} }, keys[1], keys[0])
    expect(rowLoopMode(prefs, keys[1], keys[0])).toBe('once')
    expect(rowLoopMode(prefs, keys[0], keys[0])).toBe('off')
    expect(rowLoopMode(prefs, keys[2], keys[0])).toBe('off')
  })
})
