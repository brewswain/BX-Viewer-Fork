/**
 * The tag vocabulary behind the browse sidebar, and the normalizer that keeps
 * every meta.json speaking it.
 *
 * Tags are stored lower-case. The sidebar shows one row of buttons per facet,
 * and only for tags some entry in the list actually carries, so an empty
 * category never shows up as a button that empties the grid.
 */

export type Facet = { key: string; label: string; tags: string[] }

export const FACETS: Facet[] = [
  {
    key: 'collection',
    label: 'Collection',
    tags: ['thingsnstuff style', 'synthetic', 'bouncex', 'dildo hero'],
  },
  {
    key: 'format',
    label: 'Format',
    tags: ['single song', 'compilation', 'long-form', 'multi-path', 'machine', 'calibration'],
  },
  {
    key: 'difficulty',
    label: 'Difficulty',
    tags: ['easy', 'medium', 'hard', 'extreme', 'multi-difficulty'],
  },
  { key: 'genre', label: 'Genre', tags: ['pmv', 'hmv', '3d', 'hypno', 'narration'] },
  {
    key: 'content',
    label: 'Content',
    tags: [
      'poppers',
      'edging',
      'toys',
      'sissy',
      'sissygasm',
      'feminization',
      'femboy',
      'futa',
      'furry',
      'het',
      'bbc',
      'censored',
    ],
  },
]

const LABELS: Record<string, string> = {
  'thingsnstuff style': 'BX Studio (T&S style)',
  synthetic: 'All synthetic',
  bouncex: 'BounceX',
  'dildo hero': 'Dildo Hero',
  pmv: 'PMV',
  hmv: 'HMV',
  '3d': '3D',
  bbc: 'BBC',
}

export function tagLabel(tag: string): string {
  return LABELS[tag] ?? tag.charAt(0).toUpperCase() + tag.slice(1)
}

const KNOWN = new Set(FACETS.flatMap((f) => f.tags))

/** Tags found in the data that belong to no facet, for a catch-all row. */
export function extraTags(entries: { tags?: string[] }[]): string[] {
  const out = new Set<string>()
  for (const e of entries) for (const t of e.tags ?? []) if (!KNOWN.has(t)) out.add(t)
  return [...out].sort()
}

/** 'one' keeps a single tag selected; clicking another replaces it. */
export type MatchMode = 'and' | 'or' | 'one'

export const MATCH_MODES: { mode: MatchMode; label: string; title: string }[] = [
  { mode: 'one', label: 'One', title: 'One tag at a time: clicking a tag replaces the last' },
  { mode: 'or', label: 'Any', title: 'Match any selected tag' },
  { mode: 'and', label: 'All', title: 'Match every selected tag' },
]

export function isMatchMode(v: unknown): v is MatchMode {
  return v === 'and' || v === 'or' || v === 'one'
}

/** Empty selection is "no filter". Compares lower-cased, like the stored tags. */
export function matchesSelection(
  tags: string[] | undefined,
  selected: readonly string[],
  mode: MatchMode,
): boolean {
  if (selected.length === 0) return true
  const have = new Set((tags ?? []).map((t) => t.toLowerCase()))
  return mode === 'and'
    ? selected.every((t) => have.has(t))
    : selected.some((t) => have.has(t))
}

// ── Normalizer ───────────────────────────────────────────────────────────────

/** Spelling variants folded onto one tag. */
const ALIASES: Record<string, string> = {
  moderate: 'medium',
  'easy to extreme': 'multi-difficulty',
  generated: 'synthetic',
  'full set': 'compilation',
  blacked: 'bbc',
  'big toy': 'toys',
}

/**
 * Tags that describe how a path was built rather than what is in the video, or
 * that were filler ("Other" was on every BX Studio entry and meant nothing).
 */
const DROP = new Set([
  'other',
  'carrier',
  'depth',
  'quint',
  'video-locked',
  'multi-tempo',
  'bench',
  'effects',
  'qos',
  'synced to music',
])

/**
 * Membership the old tags never carried. Furry is by folder because nothing in
 * a meta.json says it; the volumes with furry scenes still need a watch-through
 * before they join.
 */
const FURRY = new Set([
  'poppers-furry-e1',
  'poppers-furry-e2',
  'the-knot',
  'the-pop',
  'multi-pop',
  'sissy-big-toys-synth',
  'the-big-toy-night',
  'F AROUND FIND OUT',
])
const TOYS = new Set(['sissy-big-toys-synth', 'the-big-toy-night'])
const SISSYGASM = new Set(['sissygasm-training', 'after-sissygasm'])

export type TagSource = {
  title?: string
  videoCreator?: string
  pathCreator?: string
  author?: string
  tags?: string[]
}

/**
 * The canonical tag list for one entry. Idempotent, so it is safe to re-run
 * after every import.
 *
 * Song titles and the entry's own name were imported as tags on about twenty
 * videos; they are dropped by shape (an "Artist - Song" dash, or a string the
 * title, folder or creator already holds) rather than by listing each one.
 */
export function normalizeTags(folder: string, meta: TagSource): string[] {
  const names = [folder, meta.title, meta.videoCreator, meta.author]
    .filter(Boolean)
    .map((s) => (s as string).toLowerCase())
  const out = new Set<string>()

  for (const raw of meta.tags ?? []) {
    let t = raw.trim().toLowerCase()
    if (!t) continue
    t = ALIASES[t] ?? t
    if (DROP.has(t)) continue
    if (!KNOWN.has(t)) {
      if (t.includes(' - ')) continue
      if (names.some((n) => n === t || n.includes(t))) continue
    }
    out.add(t)
  }

  const path = (meta.pathCreator ?? '').toLowerCase()
  // A multi-creator credit (a compilation) naming one HMV artist says nothing
  // about the whole video, so only a sole creator counts toward pmv/hmv.
  const sole = meta.videoCreator?.includes(',') ? '' : (meta.videoCreator ?? '')
  const byline = `${folder} ${meta.title ?? ''} ${sole}`.toLowerCase()
  if (path.startsWith('bx studio')) out.add('synthetic')
  if (path.startsWith('bx studio') && path.includes('thingsnstuff style'))
    out.add('thingsnstuff style')
  if (byline.includes('pmv')) out.add('pmv')
  if (byline.includes('hmv')) out.add('hmv')
  if (out.has('dildo hero') || TOYS.has(folder)) out.add('toys')
  if (FURRY.has(folder)) out.add('furry')
  if (SISSYGASM.has(folder)) out.add('sissygasm')

  return [...out]
}
