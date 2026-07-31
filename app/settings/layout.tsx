import type { Metadata } from 'next'

// The page itself is a client component, so the title lives here.
export const metadata: Metadata = {
  title: 'Settings — BounceX Viewer',
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return children
}
