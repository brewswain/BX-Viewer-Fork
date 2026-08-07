/**
 * The quick playlist crosses a storage boundary, so what it reads back is
 * whatever was in sessionStorage last — possibly written by an older build, or
 * by nothing at all. Every malformed shape has to resolve to `null`, because
 * `null` is what makes the playlist page fall back to the full library instead
 * of rendering an empty playlist.
 */

import { describe, expect, test } from 'bun:test'

import { parseQuickPlaylist, type QuickPlaylist } from './quickPlaylist'

function stored(value: unknown): string {
  return JSON.stringify(value)
}

describe('parseQuickPlaylist', () => {
  test('round-trips a saved list', () => {
    const pl: QuickPlaylist = { title: 'Filtered videos', folders: ['a', 'b'] }
    expect(parseQuickPlaylist(stored(pl))).toEqual(pl)
  })

  test('preserves order — the grid order is the play order', () => {
    const folders = ['c', 'a', 'b']
    expect(parseQuickPlaylist(stored({ title: 'x', folders }))?.folders).toEqual(
      folders,
    )
  })

  test('falls back to null for anything unusable', () => {
    expect(parseQuickPlaylist(null)).toBeNull()
    expect(parseQuickPlaylist('')).toBeNull()
    expect(parseQuickPlaylist('not json')).toBeNull()
    expect(parseQuickPlaylist(stored({}))).toBeNull()
    expect(parseQuickPlaylist(stored({ folders: 'a' }))).toBeNull()
    expect(parseQuickPlaylist(stored({ folders: [] }))).toBeNull()
  })

  test('drops non-string and empty folder ids', () => {
    const parsed = parseQuickPlaylist(
      stored({ title: 't', folders: ['a', '', null, 3, 'b'] }),
    )
    expect(parsed?.folders).toEqual(['a', 'b'])
  })

  test('a list of only junk ids is no list at all', () => {
    expect(parseQuickPlaylist(stored({ title: 't', folders: ['', null] }))).toBeNull()
  })

  test('supplies a title when one is missing or blank', () => {
    expect(parseQuickPlaylist(stored({ folders: ['a'] }))?.title).toBe('All videos')
    expect(parseQuickPlaylist(stored({ title: '', folders: ['a'] }))?.title).toBe(
      'All videos',
    )
    expect(parseQuickPlaylist(stored({ title: 7, folders: ['a'] }))?.title).toBe(
      'All videos',
    )
  })
})
