/**
 * Does this path deal poppers breath cards, and how many cycles of them?
 *
 * The cues are bx2 text effects and there is no flag anywhere saying "this is a
 * poppers file": the only evidence is the cards themselves. So this reads the
 * vocabulary rather than an id, which keeps it true for hand-authored cards and
 * for anything a later pass writes under a different id prefix.
 *
 * A cycle is counted by its EXHALE, and both halves have to be present. That
 * second condition is not pedantry: `LunaPMV.bx` carries two `GET READY` cards
 * of its own as 1.3 s section markers, and a section marker is not a breath.
 */

import type { BxEffect } from './types'

/** The card vocabulary. The six are LustfulLoops'; the older hand-authored demo
 *  in `misbehaveme.bx` speaks three of them and still counts. */
const CARDS = new Set([
  'GET READY',
  'INHALE',
  'SMALL INHALE',
  'HOLD',
  'LONG HOLD',
  'EXHALE',
])

const OPENS = 'INHALE'
const CLOSES = 'EXHALE'

function cardText(ef: BxEffect): string {
  if (ef.type !== 'text' || typeof ef.text !== 'string') return ''
  const t = ef.text.trim().toUpperCase()
  return CARDS.has(t) ? t : ''
}

/** How many breath cycles this path deals. 0 when it is not a poppers path. */
export function poppersCycles(effects: BxEffect[] | undefined | null): number {
  if (!Array.isArray(effects)) return 0
  let opens = 0
  let closes = 0
  for (const ef of effects) {
    const t = cardText(ef)
    // `SMALL INHALE` is its own string, so it never double-counts an open.
    if (t === OPENS) opens++
    else if (t === CLOSES) closes++
  }
  return opens > 0 && closes > 0 ? closes : 0
}

export function hasPoppersCues(effects: BxEffect[] | undefined | null): boolean {
  return poppersCycles(effects) > 0
}
