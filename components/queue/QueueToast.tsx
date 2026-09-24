'use client'

import { createPortal } from 'react-dom'

import { useQueueToast } from '@/lib/queue/toast'

export default function QueueToast() {
  const toast = useQueueToast()
  if (!toast) return null
  return createPortal(
    <div
      key={toast.n}
      className="queue-toast"
      role="status"
      style={{ animationDuration: `${toast.ms}ms` }}
    >
      {toast.text}
    </div>,
    document.body,
  )
}
