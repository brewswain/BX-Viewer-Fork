/**
 * Playlist descriptions reach the player as either one string with blank-line
 * paragraphs or the manager's array of lines, and both carry `slug` names that
 * have to render as code rather than as literal backticks.
 */

import { describe, expect, test } from 'bun:test'

import { descriptionParagraphs, renderDescription } from './format'

describe('descriptionParagraphs', () => {
  test('splits a string on blank lines', () => {
    expect(descriptionParagraphs('one\n\ntwo\nstill two\n\n\nthree')).toEqual([
      'one',
      'two\nstill two',
      'three',
    ])
  })

  test('joins the manager line array before splitting', () => {
    expect(descriptionParagraphs(['first', 'line two', '', 'second'])).toEqual([
      'first\nline two',
      'second',
    ])
  })

  test('empty and missing give no paragraphs', () => {
    expect(descriptionParagraphs(undefined)).toEqual([])
    expect(descriptionParagraphs('')).toEqual([])
    expect(descriptionParagraphs(['', '  '])).toEqual([])
  })
})

describe('renderDescription', () => {
  test('renders bold, code and in-paragraph breaks', () => {
    expect(renderDescription('**POPPERS:** use `Hips`\nthen `Drop`')).toBe(
      '<strong>POPPERS:</strong> use <code>Hips</code><br>then <code>Drop</code>',
    )
  })

  test('escapes markup inside code', () => {
    expect(renderDescription('`<b>`')).toBe('<code>&lt;b&gt;</code>')
  })
})
