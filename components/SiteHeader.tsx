'use client'

import Link from 'next/link'

export type NavKey = 'browse' | 'about' | 'settings' | 'manager' | null

type Props = {
  /** Which nav link gets `.active`. */
  active?: NavKey
  /**
   * Controlled search box (browse page). Omit for pages where the box is
   * decorative — pass `searchEnabled` to keep it clickable-but-inert.
   */
  search?: { value: string; onChange: (value: string) => void }
  searchEnabled?: boolean
  /** Renders the reload-library button ahead of the nav links. */
  onRefresh?: () => void
  /** Overrides the search box placeholder (the manager uses its own wording). */
  searchPlaceholder?: string
  /**
   * Renders the manager's `.server-status` dot + label. Omit on pages that
   * never had one.
   */
  status?: 'ok' | 'error'
}

const NAV: Array<{ key: Exclude<NavKey, null>; href: string; label: string }> = [
  { key: 'browse', href: '/', label: 'Browse' },
  { key: 'about', href: '/about', label: 'About' },
  { key: 'settings', href: '/settings', label: 'Settings' },
  { key: 'manager', href: '/manager', label: 'Manager' },
]

export default function SiteHeader({
  active = null,
  search,
  searchEnabled,
  onRefresh,
  searchPlaceholder,
  status,
}: Props) {
  const disabled = !search && !searchEnabled

  return (
    <header className="site-header">
      <Link href="/" className="site-logo">
        Bounce
        <span>X</span>
      </Link>
      {status && (
        <div className="server-status">
          <div className={status === 'error' ? 'status-dot error' : 'status-dot'} id="statusDot" />
          <span id="statusText">{status === 'error' ? 'server unreachable' : 'Manager'}</span>
        </div>
      )}
      <div className="header-search">
        <span className="search-icon">
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            width="14"
            height="14"
          >
            <circle cx="9" cy="9" r="5.5" />
            <line x1="13.5" y1="13.5" x2="17" y2="17" />
          </svg>
        </span>
        <input
          type="text"
          id="searchInput"
          placeholder={searchPlaceholder ?? 'search titles, authors, tags...'}
          autoComplete="off"
          disabled={disabled}
          style={disabled ? { opacity: 0.4, cursor: 'default' } : undefined}
          value={search ? search.value : undefined}
          defaultValue={search ? undefined : ''}
          onChange={search ? (e) => search.onChange(e.target.value) : undefined}
        />
      </div>
      <nav className="header-nav" style={status ? { marginLeft: 'auto' } : undefined}>
        {onRefresh && (
          <button className="header-nav-refresh" onClick={onRefresh} title="Reload library">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        )}
        {NAV.map(({ key, href, label }) => (
          <Link key={key} href={href} className={active === key ? 'active' : undefined}>
            {label}
          </Link>
        ))}
      </nav>
    </header>
  )
}
