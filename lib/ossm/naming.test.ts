/**
 * `bxplBody` — the one function that decides what bytes an export is made of.
 *
 * The v1/v2 choice is the interesting part, and it has no visible failure mode
 * on this side: both formats load. The damage from getting it wrong happens in
 * the app, to settings this exporter never asked about, and only the user who
 * had shuffle on ever sees it.
 */

import { describe, expect, test } from 'bun:test'
import { bxplBody, statesFlags } from './naming'
import type { OssmEntry } from './types'

const entries = (...paths: string[]): OssmEntry[] => paths.map((path) => ({ path }))

describe('statesFlags', () => {
  test('unset, absent and undefined all mean "no opinion"', () => {
    expect(statesFlags({ shuffle: null, loop: null })).toBe(false)
    expect(statesFlags({})).toBe(false)
    expect(statesFlags({ shuffle: undefined, loop: undefined })).toBe(false)
  })

  test('false is an opinion — it is the one that turns a toggle off', () => {
    expect(statesFlags({ shuffle: false, loop: null })).toBe(true)
    expect(statesFlags({ shuffle: null, loop: false })).toBe(true)
  })
})

describe('bxplBody — unset flags', () => {
  test('writes legacy v1, so the app leaves shuffle and loop alone', () => {
    const body = bxplBody({ entries: entries('hope.bx', 'hopeless-hard.bx') })
    expect(body).toBe('hope.bx\nhopeless-hard.bx\n')
    // The app sniffs the first non-whitespace character for `{`; anything else
    // is the legacy parser, which reports `has_flags: false`.
    expect(body.trimStart().startsWith('{')).toBe(false)
  })

  test('an empty playlist is an empty file, not an empty JSON object', () => {
    expect(bxplBody({ entries: [] })).toBe('')
  })

  test('explicit nulls are the same as saying nothing', () => {
    expect(bxplBody({ entries: entries('hope.bx'), shuffle: null, loop: null })).toBe('hope.bx\n')
  })
})

describe('bxplBody — stated flags', () => {
  test('writes v2 with both flags and minimal entries', () => {
    const body = bxplBody({
      entries: entries('hope.bx', 'hopeless-hard.bx'),
      shuffle: true,
      loop: false,
    })
    expect(JSON.parse(body)).toEqual({
      version: 2,
      shuffle: true,
      loop: false,
      entries: [{ path: 'hope.bx' }, { path: 'hopeless-hard.bx' }],
    })
  })

  /**
   * `_parse_v2_entry` ignores keys it doesn't recognise but the app's own writer
   * omits repeat keys at their defaults, so a plain queue has to round-trip to a
   * minimal file — otherwise a real repeat setting is invisible in a diff.
   */
  test('no default mode/count noise on an entry', () => {
    const body = bxplBody({ entries: entries('hope.bx'), shuffle: false, loop: false })
    expect(body).not.toContain('mode')
    expect(body).not.toContain('count')
    expect(body).not.toContain('video_offset_ms')
  })

  test('shape matches the app writer: tab-indented, insertion order, trailing newline', () => {
    const body = bxplBody({ entries: entries('hope.bx'), shuffle: false, loop: true })
    expect(body.endsWith('\n')).toBe(true)
    expect(body).toContain('\n\t"version": 2')
    // `JSON.stringify(root, "\t", false)` passes sort_keys=false in Godot, so the
    // app's own files carry this order too.
    expect(Object.keys(JSON.parse(body))).toEqual(['version', 'shuffle', 'loop', 'entries'])
  })

  test('setting one flag still writes the other, because v2 cannot omit it', () => {
    // The known wart, and why the overlay sets them as a pair. Once the app can
    // tell an absent flag from a false one, this is the test that changes.
    const body = bxplBody({ entries: entries('hope.bx'), shuffle: true })
    expect(JSON.parse(body).loop).toBe(false)
  })

  test('version stays at 2 — a bump makes older builds refuse the file outright', () => {
    expect(JSON.parse(bxplBody({ entries: entries('a.bx'), loop: true })).version).toBe(2)
  })

  test('an entry carries nothing this exporter did not put there', () => {
    const dirty = [{ path: 'hope.bx', videoId: 'Hope' }] as unknown as OssmEntry[]
    expect(JSON.parse(bxplBody({ entries: dirty, shuffle: false })).entries).toEqual([
      { path: 'hope.bx' },
    ])
  })
})
