/**
 * The play queue: an ordered list of videos plus the one playing (or last
 * played) from it.
 *
 * Pure operations live here so they are testable without a DOM; the store in
 * `store.ts` persists them to localStorage and syncs tabs.
 *
 * Items carry a uid rather than being keyed by folder, so the same video can be
 * queued twice and a reorder or removal elsewhere cannot lose track of which
 * row is playing. Each item also snapshots the card's title, thumbnail and tags,
 * so the panel can draw a row without fetching the library.
 */

import type { RadioMark } from './radio'

export type QueueItem = {
  uid: string
  folder: string
  title?: string
  thumbnail?: string
  tags?: string[]
  durationSecs?: number
  /** Set on rows the radio added: which wave step picked it. */
  radio?: RadioMark
  /**
   * Added by hand while something else plays. These cut in ahead of the rest,
   * in the order they were added, like Spotify's "Next in queue".
   */
  added?: boolean
  /** The .bx file a playlist entry picked, when it is not the video's default. */
  bxFile?: string
}

export type Queue = {
  items: QueueItem[]
  /**
   * uid of the item the queue player is on, or last finished. Kept after the
   * queue runs out, so running dry does not wipe what was built.
   */
  current: string | null
  /** What the queue was started from ("Next from: ..."), if anything. */
  source?: string
}

export const EMPTY_QUEUE: Queue = { items: [], current: null }

export type QueueVideo = Omit<QueueItem, 'uid'>

let counter = 0
export function newUid(): string {
  counter = (counter + 1) % 1e6
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** Index of the playing item, or -1 when nothing from the queue has played. */
export function currentIndex(q: Queue): number {
  return q.current ? q.items.findIndex((i) => i.uid === q.current) : -1
}

/** Everything after the playing item: what plays next. */
export function upcoming(q: Queue): QueueItem[] {
  return q.items.slice(currentIndex(q) + 1)
}

export function append(q: Queue, video: QueueVideo, uid = newUid()): Queue {
  return { ...q, items: [...q.items, { ...video, uid }] }
}

/** Straight after the playing item, or at the front when nothing has played. */
export function playNext(q: Queue, video: QueueVideo, uid = newUid()): Queue {
  const at = currentIndex(q) + 1
  const items = [...q.items]
  items.splice(at, 0, { ...video, added: true, uid })
  return { ...q, items }
}

/** Where the next hand-added row goes: after the playing item and earlier adds. */
function addedEnd(q: Queue): number {
  let at = currentIndex(q) + 1
  while (at < q.items.length && q.items[at].added) at++
  return at
}

/**
 * Add to "Next in queue": ahead of the rest of the queue but after anything
 * added before, so adding L, M, N while A plays gives A, L, M, N, B, C.
 */
export function enqueue(q: Queue, videos: readonly QueueVideo[], uid = newUid): Queue {
  const at = addedEnd(q)
  const items = [...q.items]
  items.splice(at, 0, ...videos.map((v) => ({ ...v, added: true, uid: uid() })))
  return { ...q, items }
}

/**
 * Add after everything. A waiting radio pick goes, since radio only fills a
 * dry queue; it picks again once these have played.
 */
export function appendAll(q: Queue, videos: readonly QueueVideo[], uid = newUid): Queue {
  const cur = currentIndex(q)
  const kept = q.items.filter((it, i) => i <= cur || !it.radio)
  return { ...q, items: [...kept, ...videos.map((v) => ({ ...v, uid: uid() }))] }
}

/** A fresh queue of `videos`, the first marked as playing. */
export function replace(videos: readonly QueueVideo[], source?: string, uid = newUid): Queue {
  const items = videos.map((v) => ({ ...v, uid: uid() }))
  return { items, current: items[0]?.uid ?? null, ...(source ? { source } : {}) }
}

/** Whether anything queued is still to play; radio's look-ahead does not count. */
export function hasPending(q: Queue): boolean {
  return upcoming(q).some((i) => !i.radio)
}

/**
 * The playing item stays put: removing it would leave the player with nothing
 * to say "now playing" about, and its row has no remove button for that reason.
 */
export function remove(q: Queue, uid: string): Queue {
  if (uid === q.current) return q
  return { ...q, items: q.items.filter((i) => i.uid !== uid) }
}

/** Move `uid` to sit at index `to` of the list as it is after removal. */
export function move(q: Queue, uid: string, to: number): Queue {
  const from = q.items.findIndex((i) => i.uid === uid)
  if (from < 0) return q
  const items = [...q.items]
  const [item] = items.splice(from, 1)
  items.splice(Math.max(0, Math.min(to, items.length)), 0, item)
  return { ...q, items }
}

export function setCurrent(q: Queue, uid: string | null): Queue {
  return q.current === uid ? q : { ...q, current: uid }
}

/** Storage is shared with older builds and other tabs, so validate every field. */
export function parseQueue(raw: string | null): Queue {
  if (!raw) return EMPTY_QUEUE
  try {
    const parsed = JSON.parse(raw) as Partial<Queue>
    const items = Array.isArray(parsed.items)
      ? parsed.items.filter(
          (i): i is QueueItem =>
            !!i &&
            typeof i === 'object' &&
            typeof i.uid === 'string' &&
            typeof i.folder === 'string' &&
            i.folder !== '',
        )
      : []
    const current =
      typeof parsed.current === 'string' && items.some((i) => i.uid === parsed.current)
        ? parsed.current
        : null
    const source = typeof parsed.source === 'string' && parsed.source ? parsed.source : undefined
    return { items, current, ...(source ? { source } : {}) }
  } catch {
    return EMPTY_QUEUE
  }
}
