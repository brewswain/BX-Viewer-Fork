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
}

export type Queue = {
  items: QueueItem[]
  /**
   * uid of the item the queue player is on, or last finished. Kept after the
   * queue runs out, so running dry does not wipe what was built.
   */
  current: string | null
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
  items.splice(at, 0, { ...video, uid })
  return { ...q, items }
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
    return { items, current }
  } catch {
    return EMPTY_QUEUE
  }
}
