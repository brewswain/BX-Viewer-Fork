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
 * to easy; a single level rests one under.
 *
 *   easy..extreme  easy, medium, hard | hard | medium | extreme
 *   hard..extreme  hard | hard | medium | extreme
 *   extreme only   hard | extreme
 *   hard only      medium | hard
 */
export function waveCycle(tags: readonly string[]): WaveStep[] {
  const picked = LEVELS.map((l, i) => (tags.includes(l) ? i : -1)).filter((i) => i >= 0)
  const lo = picked.length ? Math.min(...picked) : 0
  const hi = picked.length ? Math.max(...picked) : LEVELS.length - 1
  const steps: WaveStep[] = []
  for (let l = lo; l < hi; l++) steps.push({ phase: 'build', level: l })
  if (lo < hi) steps.push({ phase: 'plateau', level: hi - 1 })
  // A single level has no climb to come down from, so its rest is just under it.
  steps.push({ phase: 'rest', level: Math.max(0, hi - (lo < hi ? 2 : 1)) })
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

/** `widened`: the taste had nothing left, so this came from the whole library. */
export type Pick = { video: QueueVideo; mark: RadioMark; widened?: true }

/** The taste minus difficulty, which steers the wave instead of filtering. */
export const tasteTags = (tags: readonly string[]) =>
  tags.filter((t) => !DIFFICULTY_TAGS.has(t))

/**
 * The taste opened up to the whole library: the tags that filter go, while
 * difficulty (the wave's shape) and the long-form opt-in stay.
 */
export const widenTaste = (tags: readonly string[]) =>
  tags.filter((t) => DIFFICULTY_TAGS.has(t) || t === OPT_IN)

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
 *
 * Radio never replays: anything already in the queue, played or waiting, sits
 * out. When that leaves the taste empty, the pick comes from the widened
 * taste instead and says so; null only once the whole library has played.
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

  const queued = new Set(q.items.map((i) => i.folder))
  const unplayed = (tags: readonly string[]) =>
    radioPool(tags, library).filter((v) => !queued.has(v._folder))
  let candidates = unplayed(settings.tags)
  let widened = false
  if (candidates.length === 0 && taste.length > 0) {
    candidates = unplayed(widenTaste(settings.tags))
    widened = true
  }
  if (candidates.length === 0) return null

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
    ...(widened ? { widened: true as const } : {}),
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
