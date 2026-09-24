'use client'

/**
 * The queue drawer's open flag. A module store rather than context because the
 * drawer is mounted by the header while the buttons that open it live in cards
 * and player sidebars with no shared provider above them.
 */

import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

export function setQueueDrawerOpen(next: boolean): void {
  if (open === next) return
  open = next
  for (const l of listeners) l()
}

export function useQueueDrawerOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => open,
    () => false,
  )
}

const DIFFICULTY = ['easy', 'medium', 'hard', 'extreme', 'multi-difficulty']

/** The difficulty tag a row shows, so the queue's overall shape is readable. */
export function difficultyOf(tags: string[] | undefined): string | null {
  const have = new Set((tags ?? []).map((t) => t.toLowerCase()))
  return DIFFICULTY.find((d) => have.has(d)) ?? null
}
