/**
 * The pure half of the post-straight-to-the-app route.
 *
 * `applyStoredNames` is the one with no visible failure mode: a playlist line
 * left pointing at the name we *asked* for, when the app stored the file as
 * `foo (2).bx`, still loads — it just plays whatever else was already sitting
 * under that name. The fetch half is not tested here; it is a browser call.
 */

import { describe, expect, test } from 'bun:test'
import {
  applyStoredNames,
  normalizeOssmAppUrl,
  OSSM_APP_PORT,
  resolveOssmAppUrl,
  summarizeSend,
} from './app'
import type { OssmSendFile, OssmSendResult } from './types'

const sent = (requested: string, stored: string | null, reused = false): OssmSendFile => ({
  requested,
  stored,
  reused,
  error: stored ? null : 'nope',
})

describe('normalizeOssmAppUrl', () => {
  test('a bare host gets the app port, not port 80', () => {
    expect(normalizeOssmAppUrl('192.168.1.5')).toBe(`http://192.168.1.5:${OSSM_APP_PORT}`)
    expect(normalizeOssmAppUrl('ossm.local')).toBe(`http://ossm.local:${OSSM_APP_PORT}`)
  })

  test('an explicit port and scheme survive', () => {
    expect(normalizeOssmAppUrl('http://192.168.1.5:9000')).toBe('http://192.168.1.5:9000')
    expect(normalizeOssmAppUrl('https://box:8081')).toBe('https://box:8081')
  })

  test('trailing slashes and pasted paths are dropped', () => {
    // The server matches the request target exactly, so a base path would turn
    // every request into a 404.
    expect(normalizeOssmAppUrl('http://127.0.0.1:8081/')).toBe('http://127.0.0.1:8081')
    expect(normalizeOssmAppUrl('http://127.0.0.1:8081/load_path')).toBe('http://127.0.0.1:8081')
  })

  test('blank stays blank, so the caller can fall back to the guess', () => {
    expect(normalizeOssmAppUrl('')).toBe('')
    expect(normalizeOssmAppUrl('   ')).toBe('')
  })
})

describe('resolveOssmAppUrl', () => {
  test('an override wins, and nothing falls back to the default', () => {
    expect(resolveOssmAppUrl('10.0.0.9')).toBe(`http://10.0.0.9:${OSSM_APP_PORT}`)
    // No `window` under the test runner, so the default is the loopback form.
    expect(resolveOssmAppUrl('')).toBe(`http://127.0.0.1:${OSSM_APP_PORT}`)
    expect(resolveOssmAppUrl(null)).toBe(`http://127.0.0.1:${OSSM_APP_PORT}`)
  })
})

describe('applyStoredNames', () => {
  test('lines follow the name the app answered with', () => {
    const files = [sent('hope.bx', 'hope.bx'), sent('hopeless-hard.bx', 'hopeless-hard (2).bx')]
    const { lines, dropped } = applyStoredNames(['hopeless-hard.bx', 'hope.bx'], files)
    expect(lines).toEqual(['hopeless-hard (2).bx', 'hope.bx'])
    expect(dropped).toEqual([])
  })

  test('a repeated line is substituted every time', () => {
    const files = [sent('hope.bx', 'hope (3).bx')]
    const { lines } = applyStoredNames(['hope.bx', 'hope.bx'], files)
    expect(lines).toEqual(['hope (3).bx', 'hope (3).bx'])
  })

  test('a reused file keeps the name already on disk', () => {
    const files = [sent('hope.bx', 'hope.bx', true)]
    expect(applyStoredNames(['hope.bx'], files).lines).toEqual(['hope.bx'])
  })

  test('a file that never stored is dropped, not left dangling', () => {
    const files = [sent('hope.bx', 'hope.bx'), sent('broken.bx', null)]
    const { lines, dropped } = applyStoredNames(['hope.bx', 'broken.bx', 'hope.bx'], files)
    expect(lines).toEqual(['hope.bx', 'hope.bx'])
    expect(dropped).toEqual(['broken.bx'])
  })

  test('a line from outside this send is left alone', () => {
    const { lines, dropped } = applyStoredNames(['delay(1.5)'], [sent('hope.bx', 'hope.bx')])
    expect(lines).toEqual(['delay(1.5)'])
    expect(dropped).toEqual([])
  })
})

describe('summarizeSend', () => {
  const result = (files: OssmSendFile[], playlist: OssmSendResult['playlist']): OssmSendResult => ({
    url: 'http://127.0.0.1:8081',
    files,
    playlistLines: [],
    droppedLines: [],
    playlist,
    warnings: [],
  })

  test('counts stored, reused and failed separately', () => {
    const out = summarizeSend(
      result([sent('a.bx', 'a.bx'), sent('b.bx', 'b.bx', true), sent('c.bx', null)], {
        outcome: 'sent',
        entries: 2,
        missing: 1,
        error: null,
      }),
    )
    expect(out).toBe('1 sent, 1 already there, 1 failed, 2 queued, 1 missing')
  })

  test('says nothing about a queue that was never loaded', () => {
    const out = summarizeSend(
      result([sent('a.bx', 'a.bx')], { outcome: 'none', entries: 0, missing: 0, error: null }),
    )
    expect(out).toBe('1 sent')
  })
})
