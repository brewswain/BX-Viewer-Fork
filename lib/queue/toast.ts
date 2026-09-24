'use client'

/**
 * One short, non-blocking notice at a time for the queue and radio, which
 * report from places with no shared provider (the Play gate, radio's top-up).
 * `n` changes on every show so a repeat restarts the timer and the animation.
 */

import { useSyncExternalStore } from 'react'

export type QueueToast = { text: string; n: number; ms: number }

let current: QueueToast | null = null
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function set(next: QueueToast | null) {
  current = next
  for (const l of listeners) l()
}

export function showQueueToast(text: string, ms = 2500): void {
  if (timer) clearTimeout(timer)
  set({ text, ms, n: (current?.n ?? 0) + 1 })
  timer = setTimeout(() => set(null), ms)
}

export function useQueueToast(): QueueToast | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
    () => null,
  )
}
