'use client'

/** The queue as a right-hand drawer, opened from the header or any ⋯ menu. */

import { useEffect } from 'react'
import { createPortal } from 'react-dom'

import QueuePanel from './QueuePanel'
import { setQueueDrawerOpen, useQueueDrawerOpen } from './queueUi'

export default function QueueDrawer() {
  // Only ever true after a click, so the portal never renders on the server.
  const open = useQueueDrawerOpen()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setQueueDrawerOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  // Portalled so theater mode hiding the header does not hide the drawer too.
  return createPortal(
    <>
      <div className="queue-drawer-scrim" onClick={() => setQueueDrawerOpen(false)} />
      <aside className="queue-drawer" aria-label="Queue">
        <div className="queue-drawer-head">
          <span>Queue</span>
          <button
            className="queue-drawer-close"
            aria-label="Close queue"
            onClick={() => setQueueDrawerOpen(false)}
          >
            ×
          </button>
        </div>
        <QueuePanel />
      </aside>
    </>,
    document.body,
  )
}
