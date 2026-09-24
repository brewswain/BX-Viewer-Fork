'use client'

/**
 * Radio settings in localStorage, and the top-up that keeps one radio pick
 * waiting in the queue once everything the user queued has played.
 *
 * One pick ahead rather than picking at the moment a video ends: the pick shows
 * in Next up, removing it rolls another for the same wave step, and the queue
 * player's existing "something new arrived" path plays it with no radio code
 * of its own.
 */

import { useSyncExternalStore } from 'react'

import * as Q from './queue'
import {
  pickNext,
  parseRadio,
  tasteTags,
  widenTaste,
  type RadioCandidate,
  type RadioSettings,
} from './radio'
import { appendToQueue, getQueue } from './store'
import { showQueueToast } from './toast'

const KEY = 'bx_radio'

let cache: { raw: string | null; settings: RadioSettings } | null = null
const listeners = new Set<() => void>()

function read(): RadioSettings {
  if (typeof window === 'undefined') return parseRadio(null)
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return cache?.settings ?? parseRadio(null)
  }
  if (!cache || cache.raw !== raw) cache = { raw, settings: parseRadio(raw) }
  return cache.settings
}

export function getRadio(): RadioSettings {
  return read()
}

export function setRadio(patch: Partial<RadioSettings>): void {
  const next = { ...read(), ...patch }
  const raw = JSON.stringify(next)
  cache = { raw, settings: next }
  try {
    localStorage.setItem(KEY, raw)
  } catch {
    // Kept in memory for this tab.
  }
  for (const l of listeners) l()
}

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

export function useRadio(): RadioSettings {
  return useSyncExternalStore(subscribe, read, () => parseRadio(null))
}

let inFlight: Promise<string | null> | null = null
let dryAt = -1

/**
 * Append one radio pick when radio is on and nothing is left to play, and
 * return the uid now waiting next (the pick, or whatever was already queued).
 * Concurrent calls in one tab share a single pick.
 *
 * `ended` is the tags of a video that just ended outside the queue, so a fresh
 * wave joins at its level.
 */
export function radioTopUp(ended?: readonly string[]): Promise<string | null> {
  const waiting = Q.upcoming(getQueue())[0]
  if (waiting) return Promise.resolve(waiting.uid)
  if (!getRadio().enabled) return Promise.resolve(null)
  inFlight ??= (async () => {
    try {
      const res = await fetch('/api/library', { cache: 'no-store' })
      if (!res.ok) return null
      const { videos } = (await res.json()) as { videos: RadioCandidate[] }
      // Re-read after the fetch: another tab may have queued something meanwhile.
      const q = getQueue()
      const already = Q.upcoming(q)[0]
      if (already) return already.uid
      const settings = getRadio()
      const pick = pickNext(q, settings, videos, Math.random, ended)
      if (!pick) {
        // Once per queue length, since the queue player asks again on every change.
        if (dryAt !== q.items.length) {
          dryAt = q.items.length
          showQueueToast('Radio has played every video in the library', 5000)
        }
        return null
      }
      if (pick.widened) {
        const was = tasteTags(settings.tags).join(', ')
        setRadio({ tags: widenTaste(settings.tags) })
        showQueueToast(`Radio ran out of ${was} videos, so it's opening up to the whole library`, 5000)
      }
      const after = appendToQueue({ ...pick.video, radio: pick.mark })
      return after.items[after.items.length - 1].uid
    } catch {
      return null
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}
