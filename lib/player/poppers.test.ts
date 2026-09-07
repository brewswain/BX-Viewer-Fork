/**
 * The detector reads a vocabulary, so the cases that matter are the ones where
 * a file speaks part of that vocabulary without dealing breath: `LunaPMV.bx`
 * uses `GET READY` as a section title, and plenty of scripted JOIs say `HOLD`.
 */

import { describe, expect, test } from 'bun:test'

import { hasPoppersCues, poppersCycles } from './poppers'
import type { BxEffect } from './types'

let frame = 0
function card(text: string, type = 'text'): BxEffect {
  frame += 100
  return { id: `e${frame}`, type, startFrame: frame, endFrame: frame + 60, text } as BxEffect
}

/** One full cycle in the six-card vocabulary, in the order the cues are written. */
function cycle(): BxEffect[] {
  return [
    card('GET READY'),
    card('INHALE'),
    card('SMALL INHALE'),
    card('HOLD'),
    card('LONG HOLD'),
    card('EXHALE'),
  ]
}

describe('poppersCycles', () => {
  test('counts one per EXHALE', () => {
    expect(poppersCycles(cycle())).toBe(1)
    expect(poppersCycles([...cycle(), ...cycle(), ...cycle()])).toBe(3)
  })

  test('SMALL INHALE does not double-count the open', () => {
    // Both strings are in the vocabulary and only the bare one opens a cycle.
    expect(poppersCycles([card('INHALE'), card('SMALL INHALE'), card('EXHALE')])).toBe(1)
  })

  test('accepts the older three-card demo', () => {
    // No file speaks this any more: misbehaveme.bx was the last and it was brought up to
    // the six-card set on 2026-09-07. Kept because the detector reads the WORDS rather
    // than our id prefix, so a hand-authored cycle that says only these three is still a
    // poppers path and the pill should light for it.
    expect(poppersCycles([card('INHALE'), card('HOLD'), card('EXHALE')])).toBe(1)
  })

  test('a section marker is not a breath', () => {
    // LunaPMV.bx: two `GET READY` chapter titles, no cycle anywhere in the file.
    expect(poppersCycles([card('GET READY'), card('GET READY')])).toBe(0)
    // A JOI that says HOLD without ever telling you to breathe in or out.
    expect(poppersCycles([card('HOLD'), card('Lube up quick')])).toBe(0)
    // Half a cycle is not a cycle: the vocabulary needs both ends.
    expect(poppersCycles([card('INHALE'), card('HOLD')])).toBe(0)
  })

  test('is case and whitespace insensitive, and ignores non-text effects', () => {
    expect(poppersCycles([card(' inhale '), card('Exhale')])).toBe(1)
    expect(poppersCycles([card('INHALE', 'image'), card('EXHALE', 'image')])).toBe(0)
  })

  test('survives a v1 path, which has no effects array at all', () => {
    expect(poppersCycles([])).toBe(0)
    expect(poppersCycles(undefined)).toBe(0)
    expect(poppersCycles(null)).toBe(0)
    expect(hasPoppersCues(undefined)).toBe(false)
    expect(hasPoppersCues(cycle())).toBe(true)
  })
})
