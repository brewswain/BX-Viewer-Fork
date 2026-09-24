import type { Metadata, Viewport } from 'next'
import { Suspense } from 'react'

import QueueSession from '@/components/queue/QueueSession'
import './globals.css'

export const metadata: Metadata = {
  title: 'BounceX Viewer',
  description: 'A .bx file and video player.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* useSearchParams needs a boundary, or every page renders client-side. */}
        <Suspense fallback={null}>
          <QueueSession />
        </Suspense>
        {children}
      </body>
    </html>
  )
}
