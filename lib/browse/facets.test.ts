import { describe, expect, it } from 'bun:test'
import { matchesSelection, normalizeTags } from './facets'

describe('matchesSelection', () => {
  it('passes everything when nothing is selected', () => {
    expect(matchesSelection(['bouncex'], [], 'and')).toBe(true)
    expect(matchesSelection(undefined, [], 'or')).toBe(true)
  })

  it('OR needs any selected tag, AND needs all of them', () => {
    const tags = ['bouncex', 'hard']
    expect(matchesSelection(tags, ['hard', 'furry'], 'or')).toBe(true)
    expect(matchesSelection(tags, ['hard', 'furry'], 'and')).toBe(false)
    expect(matchesSelection(tags, ['hard', 'bouncex'], 'and')).toBe(true)
  })

  it('ignores the case of stored tags', () => {
    expect(matchesSelection(['BounceX'], ['bouncex'], 'or')).toBe(true)
  })
})

describe('normalizeTags', () => {
  it('folds casing duplicates and aliases', () => {
    expect(normalizeTags('x', { tags: ['BounceX', 'bouncex', 'Moderate', 'Generated'] })).toEqual([
      'bouncex',
      'medium',
      'synthetic',
    ])
  })

  it('drops song titles, the entry name and filler', () => {
    const tags = normalizeTags('Misbehave Me', {
      title: 'CYBERSLUT SHOWDOWN (full set)',
      videoCreator: 'RawSource',
      tags: ['Other', 'K/DA - VILLAIN', 'Misbehave Me', 'CYBERSLUT SHOWDOWN', 'RawSource', 'hard'],
    })
    expect(tags).toEqual(['hard'])
  })

  it('keeps unknown tags that are not names', () => {
    expect(normalizeTags('caged-w1-ramp', { tags: ['scheduled'] })).toEqual(['scheduled'])
  })

  it('marks BX Studio paths synthetic, and T&S-style ones as the narrow tag too', () => {
    const ts = normalizeTags('strong-order', { pathCreator: 'BX Studio (ThingsnStuff style)' })
    expect(ts).toContain('synthetic')
    expect(ts).toContain('thingsnstuff style')
    const other = normalizeTags('goonie-boy', { pathCreator: 'BX Studio (video-rhythm synthesis)' })
    expect(other).toContain('synthetic')
    expect(other).not.toContain('thingsnstuff style')
    // A human ThingsnStuff path is not a BX Studio one.
    expect(normalizeTags('Hope', { pathCreator: 'ThingsnStuff' })).not.toContain('synthetic')
  })

  it('adds membership the old tags never carried', () => {
    expect(normalizeTags('the-big-toy-night', {})).toEqual(['toys', 'furry'])
    expect(normalizeTags('x', { tags: ['dildo hero'] })).toContain('toys')
    expect(normalizeTags('closer-pmv-hmv', {})).toEqual(['pmv', 'hmv'])
  })

  it('is idempotent', () => {
    const once = normalizeTags('the-knot', {
      pathCreator: 'BX Studio (longform/render_path.py)',
      tags: ['Generated', 'Other', 'carrier', 'hypno'],
    })
    expect(normalizeTags('the-knot', { tags: once })).toEqual(
      normalizeTags('the-knot', { tags: once }),
    )
    expect(new Set(normalizeTags('the-knot', { pathCreator: 'BX Studio', tags: once }))).toEqual(
      new Set(once),
    )
  })
})
