'use client'

/**
 * The queue, persisted to localStorage and shared by every tab.
 *
 * localStorage rather than sessionStorage (the "play all" list's home) because
 * the point is building the queue in a browse tab while another tab plays it.
 * Other tabs hear about writes through the `storage` event, which never fires
 * in the tab that wrote, so writers notify their own listeners directly.
 */

import { useSyncExternalStore } from 'react'

import * as Q from './queue'

const KEY = 'bx_queue'

let cache: { raw: string | null; queue: Q.Queue } | null = null
const listeners = new Set<() => void>()

function read(): Q.Queue {
  if (typeof window === 'undefined') return Q.EMPTY_QUEUE
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    // Blocked storage: the queue works for this page view and is then lost.
    return cache?.queue ?? Q.EMPTY_QUEUE
  }
  // A stable object per stored string, or useSyncExternalStore re-renders forever.
  if (!cache || cache.raw !== raw) cache = { raw, queue: Q.parseQueue(raw) }
  return cache.queue
}

function write(next: Q.Queue): void {
  const raw = JSON.stringify(next)
  cache = { raw, queue: next }
  try {
    localStorage.setItem(KEY, raw)
  } catch {
    // Kept in memory for this tab; see `read`.
  }
  for (const l of listeners) l()
}

function update(fn: (q: Q.Queue) => Q.Queue): Q.Queue {
  const before = read()
  const after = fn(before)
  if (after !== before) write(after)
  return after
}

export function getQueue(): Q.Queue {
  return read()
}

export const addToQueue = (video: Q.QueueVideo) => update((q) => Q.append(q, video))
export const addNext = (video: Q.QueueVideo) => update((q) => Q.playNext(q, video))
export const removeFromQueue = (uid: string) => update((q) => Q.remove(q, uid))
export const moveInQueue = (uid: string, to: number) => update((q) => Q.move(q, uid, to))
export const setQueueCurrent = (uid: string | null) => update((q) => Q.setCurrent(q, uid))
export const clearQueue = () => update(() => Q.EMPTY_QUEUE)

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useQueue(): Q.Queue {
  return useSyncExternalStore(subscribe, read, () => Q.EMPTY_QUEUE)
}

/** The reserved playlist id the playlist page plays the queue under. */
export const QUEUE_PLAYLIST_ID = '__queue__'

/** Link that plays the queue starting at `uid`. */
export function queueHref(uid?: string | null): string {
  return `/playlist?p=${QUEUE_PLAYLIST_ID}${uid ? `&at=${encodeURIComponent(uid)}` : ''}`
}

/**
 * Where "Play" in the panel starts: the next unplayed item, or from the top once
 * everything has played.
 */
export function playStartUid(q: Q.Queue): string | null {
  return Q.upcoming(q)[0]?.uid ?? q.items[0]?.uid ?? null
}
