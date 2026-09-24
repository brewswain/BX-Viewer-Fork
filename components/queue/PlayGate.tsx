'use client'

/**
 * Every Play goes through the queue. With nothing waiting in it, Play replaces
 * the queue and starts; with videos still waiting, a dialog asks whether to
 * clear them or add the new videos instead, so a stray click never wipes a
 * queue that took a while to build.
 *
 * A module store, like the drawer's open flag, because the cards and buttons
 * that play things have no shared provider with the header that draws the
 * dialog.
 */

import { useRouter } from 'next/navigation'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

import { hasPending, upcoming, type QueueVideo } from '@/lib/queue/queue'
import {
  addToEnd,
  addToQueue,
  getQueue,
  queueHref,
  replaceQueue,
} from '@/lib/queue/store'

type Request = {
  /** "Next from: ..." in the queue panel, and the dialog's wording. */
  title: string
  videos: QueueVideo[]
  navigate: (href: string) => void
}

let pending: Request | null = null
const listeners = new Set<() => void>()

function setPending(next: Request | null) {
  pending = next
  for (const l of listeners) l()
}

function usePending(): Request | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => pending,
    () => null,
  )
}

/**
 * One video opens its watch page, which has the suggestions and stats; more
 * than one plays in the queue player.
 */
function start(req: Request) {
  // A lone video is its own "now playing"; only a list has a "Next from".
  const q = replaceQueue(req.videos, req.videos.length > 1 ? req.title : undefined)
  const first = q.items[0]
  if (!first) return
  req.navigate(
    q.items.length === 1 ? `/watch?v=${encodeURIComponent(first.folder)}` : queueHref(first.uid),
  )
}

/** Play `videos` as a fresh queue, or ask first when the queue has some waiting. */
export function usePlay(): (title: string, videos: QueueVideo[]) => void {
  const router = useRouter()
  return (title, videos) => {
    if (videos.length === 0) return
    const req = { title, videos, navigate: (href: string) => router.push(href) }
    if (hasPending(getQueue())) setPending(req)
    else start(req)
  }
}

/** Left click with no modifier: the others keep their open-in-new-tab meaning. */
export function isPlainClick(e: React.MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
}

type LibraryVideo = {
  _folder: string
  title?: string
  thumbnail?: string
  tags?: string[]
  durationSecs?: number
}

let library: Promise<Map<string, LibraryVideo>> | null = null

/**
 * Queue rows for folder ids, with the card fields filled from the library so
 * the panel can draw them. A folder the library lacks still plays.
 */
export async function videosFor(
  entries: readonly { folder: string; bxFile?: string }[],
): Promise<QueueVideo[]> {
  library ??= fetch('/api/library')
    .then((r) => (r.ok ? r.json() : { videos: [] }))
    .then((d: { videos: LibraryVideo[] }) => new Map(d.videos.map((v) => [v._folder, v])))
    .catch(() => {
      library = null
      return new Map<string, LibraryVideo>()
    })
  const byFolder = await library
  return entries.map(({ folder, bxFile }) => {
    const v = byFolder.get(folder)
    return {
      folder,
      title: v?.title,
      thumbnail: v?.thumbnail,
      tags: v?.tags,
      durationSecs: v?.durationSecs,
      ...(bxFile ? { bxFile } : {}),
    }
  })
}

const count = (n: number) => `${n} ${n === 1 ? 'video' : 'videos'}`

export default function PlayGate() {
  const req = usePending()
  // Adding confirms in a toast, so the dialog closes at once and nothing blocks.
  const [toast, setToast] = useState<{ text: string; n: number } | null>(null)

  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPending(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [req])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(t)
  }, [toast])

  // `n` restarts the timer and the entry animation when adds come in a row.
  const added = (text: string) => {
    setPending(null)
    setToast((prev) => ({ text, n: (prev?.n ?? 0) + 1 }))
  }

  const toastEl = toast && (
    <div key={toast.n} className="queue-toast" role="status">
      {toast.text}
    </div>
  )
  if (!req) return toastEl && createPortal(toastEl, document.body)
  const left = upcoming(getQueue()).length
  const what = req.videos.length === 1 ? (req.videos[0].title ?? req.title) : req.title

  return createPortal(
    <>
      <div className="play-gate-scrim" onClick={() => setPending(null)} />
      <div className="play-gate" role="dialog" aria-modal="true" aria-labelledby="play-gate-title">
        <button className="play-gate-close" aria-label="Cancel" onClick={() => setPending(null)}>
          ×
        </button>
        <h2 id="play-gate-title">Your queue has {count(left)} waiting</h2>
        <p>
          Playing <strong>{what}</strong>
          {req.videos.length > 1 ? ` (${count(req.videos.length)})` : ''} will clear it.
        </p>
        <div className="play-gate-actions">
          <button
            className="queue-btn danger"
            onClick={() => {
              setPending(null)
              start(req)
            }}
          >
            Clear queue and play
          </button>
          <button
            className="queue-btn primary"
            onClick={() => {
              addToQueue(...req.videos)
              added(`Added ${what} to Next in queue`)
            }}
          >
            Add to Next in queue
          </button>
          <button
            className="queue-btn"
            onClick={() => {
              addToEnd(...req.videos)
              added(`Added ${what} to the end of the queue`)
            }}
          >
            Add to end of queue
          </button>
        </div>
      </div>
      {toastEl}
    </>,
    document.body,
  )
}
