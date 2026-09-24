/**
 * Radio: what the queue plays once it runs dry.
 *
 * Two inputs. The taste is a set of tag buttons picked without looking at any
 * videos. The wave is the T&S session shape (build, plateau, rest, explosion)
 * laid over whole videos, so a run of picks climbs, holds, drops for a breather
 * and then goes all out, and rests still arrive when the taste is all hard and
 * extreme.
 *
 * Pure, so it is testable without a DOM; `radioStore.ts` does the fetching and
 * the queue writes.
 */

import type { Queue, QueueVideo } from './queue'

export const LEVELS = ['easy', 'medium', 'hard', 'extreme'] as const

export type Phase = 'build' | 'plateau' | 'rest' | 'explosion'

export type WaveStep = { phase: Phase; level: number }

/** Stamped on queue rows the radio added; `step` is the index into the cycle. */
export type RadioMark = WaveStep & { step: number }

export type RadioSettings = { enabled: boolean; tags: string[] }

export const DEFAULT_RADIO: RadioSettings = { enabled: false, tags: [] }

/** A library entry, as `/api/library` returns it. */
export type RadioCandidate = {
  _folder: string
  title?: string
  thumbnail?: string
  tags?: string[]
  durationSecs?: number
}

/**
 * Difficulty tags in the taste set the wave's range; with none picked it spans
 * everything. One cycle: build a step at a time up to just below the top, hold
 * there once more, rest two levels under the top, then the top. The rest keys
 * off the top rather than the floor so a wide range does not drop all the way
 * to easy.
 *
 *   easy..extreme  easy, medium, hard | hard | medium | extreme
 *   hard..extreme  hard | hard | medium | extreme
 *   extreme only   medium | extreme
 *   hard only      easy | hard
 */
export function waveCycle(tags: readonly string[]): WaveStep[] {
  const picked = LEVELS.map((l, i) => (tags.includes(l) ? i : -1)).filter((i) => i >= 0)
  const lo = picked.length ? Math.min(...picked) : 0
  const hi = picked.length ? Math.max(...picked) : LEVELS.length - 1
  const steps: WaveStep[] = []
  for (let l = lo; l < hi; l++) steps.push({ phase: 'build', level: l })
  if (lo < hi) steps.push({ phase: 'plateau', level: hi - 1 })
  steps.push({ phase: 'rest', level: Math.max(0, hi - 2) })
  steps.push({ phase: 'explosion', level: hi })
  return steps
}

/**
 * The cycle index the next pick takes: one on from the last radio row.
 *
 * With no radio row yet, the wave joins where the video that just played left
 * off (`after`, else the queue's current item) instead of dropping back to the
 * bottom: the first build or plateau at or above its level, or the rest when
 * it was already at the top.
 */
export function nextStep(
  q: Queue,
  cycle: readonly WaveStep[],
  after?: readonly string[],
): number {
  for (let i = q.items.length - 1; i >= 0; i--) {
    const mark = q.items[i].radio
    if (mark) return (mark.step + 1) % cycle.length
  }
  const seed = levelRange(after ?? q.items.find((i) => i.uid === q.current)?.tags)
  if (!seed) return 0
  // The top of a range tag: a hard..extreme video already reached extreme.
  const climb = cycle.findIndex(
    (s) => (s.phase === 'build' || s.phase === 'plateau') && s.level >= seed[1],
  )
  return climb >= 0 ? climb : cycle.findIndex((s) => s.phase === 'rest')
}

/** [lo, hi] level range a video's tags claim, or null when it carries none. */
export function levelRange(tags: readonly string[] | undefined): [number, number] | null {
  const have = new Set((tags ?? []).map((t) => t.toLowerCase()))
  const idx = LEVELS.map((l, i) => (have.has(l) ? i : -1)).filter((i) => i >= 0)
  return idx.length ? [Math.min(...idx), Math.max(...idx)] : null
}

const DIFFICULTY_TAGS = new Set<string>([...LEVELS])

/** Never on the radio: test patterns, not something to watch. */
const NEVER = 'calibration'
/**
 * Only when asked for, since one of these fills an hour or more. Length counts
 * as well as the tag: the BX Studio volumes run 80 to 120 minutes untagged.
 */
const OPT_IN = 'long-form'
const LONG_SECS = 20 * 60

/** Short enough to count as a breather in a rest step. */
const SHORT_SECS = 6 * 60

/** How many recent queue rows are off limits, as a share of the pool. */
const RECENT_SHARE = 0.5
const RECENT_MAX = 12

export type Pick = { video: QueueVideo; mark: RadioMark }

/** The taste minus difficulty, which steers the wave instead of filtering. */
const tasteTags = (tags: readonly string[]) => tags.filter((t) => !DIFFICULTY_TAGS.has(t))

/** Every video the taste allows, before the wave weighs them. */
export function radioPool<T extends RadioCandidate>(
  tags: readonly string[],
  library: readonly T[],
): T[] {
  const taste = tasteTags(tags)
  return library.filter((v) => {
    const have = v.tags ?? []
    if (have.includes(NEVER)) return false
    const long = have.includes(OPT_IN) || (v.durationSecs ?? 0) > LONG_SECS
    if (long && !taste.includes(OPT_IN)) return false
    return taste.length === 0 || taste.some((t) => have.includes(t))
  })
}

/**
 * Weighted random pick for the next wave step.
 *
 * Taste tags other than difficulty are a filter (a video must share one) and a
 * boost (each extra shared tag weighs more). The draw is only from the videos
 * closest to the step's level, so it lands on the level whenever one exists.
 * Videos from the recent end of the queue sit out, so a small pool does not
 * loop the same two.
 */
export function pickNext(
  q: Queue,
  settings: RadioSettings,
  library: readonly RadioCandidate[],
  rng: () => number = Math.random,
  after?: readonly string[],
): Pick | null {
  const cycle = waveCycle(settings.tags)
  const step = nextStep(q, cycle, after)
  const target = cycle[step]
  const taste = tasteTags(settings.tags)

  const pool = radioPool(settings.tags, library)
  if (pool.length === 0) return null

  const recentCount = Math.min(RECENT_MAX, Math.floor(pool.length * RECENT_SHARE))
  const recent = new Set(
    recentCount > 0 ? q.items.slice(-recentCount).map((i) => i.folder) : [],
  )
  const fresh = pool.filter((v) => !recent.has(v._folder))
  const candidates = fresh.length ? fresh : pool

  // Levels away from the step; untagged counts as one off. Only the closest
  // tier is drawn from, since weighting alone lets thirty hard videos drown
  // three medium ones and a rest stops being a rest.
  const distance = (v: RadioCandidate): number => {
    const range = levelRange(v.tags)
    if (!range) return 1
    if (target.level < range[0]) return range[0] - target.level
    return Math.max(0, target.level - range[1])
  }
  const best = Math.min(...candidates.map(distance))
  const tier = candidates.filter((v) => distance(v) === best)

  const weights = tier.map((v) => {
    const shared = taste.filter((t) => v.tags?.includes(t)).length
    const short = target.phase === 'rest' && (v.durationSecs ?? Infinity) <= SHORT_SECS ? 2 : 1
    return (1 + shared) * short
  })

  const total = weights.reduce((s, w) => s + w, 0)
  let r = rng() * total
  let chosen = tier[tier.length - 1]
  for (let i = 0; i < tier.length; i++) {
    r -= weights[i]
    if (r < 0) {
      chosen = tier[i]
      break
    }
  }

  return {
    video: {
      folder: chosen._folder,
      title: chosen.title,
      thumbnail: chosen.thumbnail,
      tags: chosen.tags,
      durationSecs: chosen.durationSecs,
    },
    mark: { ...target, step },
  }
}

export function parseRadio(raw: string | null): RadioSettings {
  if (!raw) return DEFAULT_RADIO
  try {
    const p = JSON.parse(raw) as Partial<RadioSettings>
    return {
      enabled: p.enabled === true,
      tags: Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : [],
    }
  } catch {
    return DEFAULT_RADIO
  }
}
