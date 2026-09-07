/**
 * Server side: how many breath cycles does a VIDEO deal, across all its paths?
 *
 * `poppers.ts` answers that for one already-loaded path, which is what the watch
 * and playlist pages want: they know which .bx is on screen. The browse grid does
 * not. A card has no path dropdown, so it can only ask the video-level question,
 * and answering it means reading the .bx files themselves. Nothing in meta.json
 * records this, deliberately (a `meta.tags` entry would light on a video's OTHER
 * path as well and lie), so the files are the only source of truth.
 *
 * THE COUNT IS THE MAXIMUM OVER THE VIDEO'S PATHS, not the default path's and not
 * the sum. Four videos in the library carry cues on one path out of several
 * (`sissy-big-toys-synth` has nine), so a sum would be nonsense. Max over "any
 * path" rather than "the default" is the choice that cannot make a cued video
 * invisible: if the cues ever move off a default path the card still finds it,
 * and the worst case is a card promising cycles that the watch page's opening
 * path does not show, which is visible and self-correcting. A dark card would be
 * neither. Verified 2026-09-07: all four multi-path cued videos have the cues on
 * their DEFAULT path, so the card and the watch page agree everywhere today.
 *
 * COST. 108 .bx files, 10.4 MB. The library route is deliberately uncached
 * because meta.json is hand-edited, and that reasoning does not carry to here: a
 * cache keyed on (path, mtime, size) goes stale exactly never, because it
 * invalidates on the write that would have made it wrong. So the walk is one
 * stat per file after the first request. The first one is bounded further by
 * rejecting on the string before the parse.
 */

import fs from 'node:fs/promises'
import { safeJoin } from '@/lib/paths'
import { poppersCycles } from './poppers'

type CacheEntry = { mtimeMs: number; size: number; cycles: number }

/**
 * Module scope, so it spans requests. Bounded by the library's file count rather
 * than by traffic: a key is a real path on disk, and a path that stops existing
 * simply stops being asked for.
 */
const cache = new Map<string, CacheEntry>()

/**
 * A .bx over this is not a cue file. The largest in the library is a 1.03 MB
 * longform path; 8 MB leaves an order of magnitude of headroom and still refuses
 * to pull something pathological into memory on a page load.
 */
const MAX_BYTES = 8 * 1024 * 1024

/** Cycles on one .bx, or 0 for anything unreadable, oversized or cue-free. */
async function cyclesInFile(file: string): Promise<number> {
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(file)
  } catch {
    return 0
  }
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.cycles

  let cycles = 0
  if (stat.size <= MAX_BYTES) {
    try {
      const raw = await fs.readFile(file, 'utf8')
      // Cheap reject ahead of the parse. Eighty of the library's 108 paths carry
      // no cue at all and several are ~1 MB of markers, so most of the walk never
      // reaches JSON.parse. It can only ever skip a file with no EXHALE anywhere
      // in its bytes, and `poppersCycles` scores those 0 regardless, so this
      // cannot disagree with the detector.
      if (/exhale/i.test(raw)) {
        const doc = JSON.parse(raw) as { effects?: unknown }
        cycles = poppersCycles(Array.isArray(doc?.effects) ? doc.effects : null)
      }
    } catch {
      cycles = 0
    }
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, cycles })
  return cycles
}

/**
 * The most cycles any one of `files` deals, resolved inside `dir`.
 *
 * `files` comes from a hand-edited meta.json, so each name goes through
 * `safeJoin` rather than `path.join`: a `../` in a bxFiles entry is refused
 * instead of read.
 */
export async function scanPoppersCycles(dir: string, files: string[]): Promise<number> {
  const targets = files
    .map((f) => (typeof f === 'string' && f ? safeJoin(dir, [f]) : null))
    .filter((f): f is string => f !== null)
  if (targets.length === 0) return 0
  const counts = await Promise.all(targets.map(cyclesInFile))
  return Math.max(0, ...counts)
}

/** Test seam: drop the mtime cache. */
export function clearPoppersScanCache(): void {
  cache.clear()
}
