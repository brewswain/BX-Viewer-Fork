'use client'

/**
 * Leaving the queue player ends the queue. A tab counts as playing the queue
 * on /playlist?p=__queue__, or on /watch for the queue's current video (a
 * lone Play and radio run there). When that tab navigates anywhere else, the
 * queue is cleared, so a Play from any tab afterwards starts fresh instead of
 * asking over a session nobody is listening to.
 *
 * Only in-app navigation counts: a reload keeps the queue, and so does closing
 * the tab. Other tabs never clear it, since the previous route is per tab.
 */

import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useRef } from 'react'

import type { Queue } from '@/lib/queue/queue'
import { clearQueue, getQueue, QUEUE_PLAYLIST_ID } from '@/lib/queue/store'
import { showQueueToast } from '@/lib/queue/toast'

function playsQueue(path: string, params: URLSearchParams, q: Queue): boolean {
  if (path === '/playlist') return params.get('p') === QUEUE_PLAYLIST_ID
  if (path !== '/watch') return false
  const current = q.items.find((i) => i.uid === q.current)
  return !!current && params.get('v') === current.folder
}

export default function QueueSession() {
  const path = usePathname()
  const params = useSearchParams()
  /** The session this tab was playing: its first row, since a fresh Play gets new uids. */
  const playing = useRef<string | null>(null)

  useEffect(() => {
    const q = getQueue()
    if (playsQueue(path, params, q)) {
      playing.current = q.items[0]?.uid ?? null
      return
    }
    // A Play that replaced the queue on the way out leaves the new one alone.
    if (playing.current && playing.current === q.items[0]?.uid) {
      clearQueue()
      showQueueToast('Left the queue, so it was cleared', 3000)
    }
    playing.current = null
  }, [path, params])

  return null
}
