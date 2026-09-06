import { describe, expect, it } from 'bun:test'
import { filterByCategory, matchesCategory } from './tagFilter'

const dildoHero = new Set(['Dildo Hero'])

describe('matchesCategory', () => {
  it('passes everything when nothing is selected', () => {
    expect(matchesCategory(['bouncex'], new Set())).toBe(true)
    expect(matchesCategory(undefined, new Set())).toBe(true)
  })

  // The bug: the chip is 'Dildo Hero', all 17 LustfulLoops entries tag
  // 'dildo hero', and an exact match found none of them.
  it('matches a lower-cased tag against a title-cased chip', () => {
    expect(matchesCategory(['dildo hero', 'compilation'], dildoHero)).toBe(true)
  })

  it('matches a title-cased tag against the same chip', () => {
    expect(matchesCategory(['Dildo Hero'], dildoHero)).toBe(true)
  })

  it('still rejects an entry with no tag in the category', () => {
    expect(matchesCategory(['bouncex', 'hard'], dildoHero)).toBe(false)
    expect(matchesCategory(undefined, dildoHero)).toBe(false)
  })

  it('is an OR across the selected chips', () => {
    const easyOrHard = new Set(['Easy', 'Hard'])
    expect(matchesCategory(['hard'], easyOrHard)).toBe(true)
    expect(matchesCategory(['medium'], easyOrHard)).toBe(false)
  })
})

describe('filterByCategory', () => {
  const videos = [
    { id: 'goonie-boy', tags: ['dildo hero', 'compilation'] },
    { id: 'GoldBull', tags: ['bouncex', 'easy', 'single song', 'Easy', 'BounceX'] },
    { id: 'bouncex-v6-pt-1', tags: ['bouncex', 'hard', 'compilation'] },
    { id: 'no-tags' },
  ]

  it('returns the same list when nothing is selected', () => {
    expect(filterByCategory(videos, new Set())).toBe(videos)
  })

  it('finds the lower-cased entries a case-sensitive match missed', () => {
    expect(filterByCategory(videos, dildoHero).map((v) => v.id)).toEqual(['goonie-boy'])
    expect(filterByCategory(videos, new Set(['Compilation'])).map((v) => v.id)).toEqual([
      'goonie-boy',
      'bouncex-v6-pt-1',
    ])
  })

  // GoldBull carries both 'easy' and 'Easy'; folding case must not list it twice.
  it('yields each entry once even when it carries both casings', () => {
    expect(filterByCategory(videos, new Set(['Easy'])).map((v) => v.id)).toEqual(['GoldBull'])
  })

  it('preserves the manifest order of what survives', () => {
    const kept = filterByCategory(videos, new Set(['BounceX'])).map((v) => v.id)
    expect(kept).toEqual(['GoldBull', 'bouncex-v6-pt-1'])
  })
})
