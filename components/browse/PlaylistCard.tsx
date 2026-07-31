'use client'

import Link from 'next/link'
import { useState } from 'react'

export type PlaylistVideoRef = string | { id?: string; videoId?: string }

export type PlaylistMeta = {
  /** Manifest folder id, stamped on at fetch time (legacy `_id`). */
  _id: string
  title?: string
  author?: string
  thumbnail?: string
  tags?: string[]
  videos?: PlaylistVideoRef[]
  totalDurationSecs?: number
}

export function secsToRuntime(secs: number): string {
  const s = Math.floor(secs)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  if (hh > 0) {
    return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  }
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

export function PlaylistPlaceholder() {
  return (
    <div className="card-thumb-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
        <polygon points="10,9 10,15 15,12" />
      </svg>
    </div>
  )
}

export default function PlaylistCard({
  playlist,
  index,
}: {
  playlist: PlaylistMeta
  index: number
}) {
  const p = playlist
  const videoCount = (p.videos || []).length

  // Try to get thumbnail from first video
  const first = p.videos && p.videos[0]
  const firstVideoId = first
    ? typeof first === 'string'
      ? first
      : first.id || first.videoId
    : null
  const thumbSrc = p.thumbnail
    ? `/playlists/${encodeURIComponent(p._id)}/${encodeURIComponent(p.thumbnail)}`
    : firstVideoId
      ? `/videos/${encodeURIComponent(firstVideoId)}/thumb.jpg`
      : null

  const [thumbFailed, setThumbFailed] = useState(false)

  const highlights = (p.tags || []).slice(0, 3)

  return (
    <Link
      className="video-card"
      href={`/playlist?p=${encodeURIComponent(p._id)}`}
      style={{ animationDelay: `${index * 0.04}s` }}
    >
      <div className="card-thumb">
        {thumbSrc && !thumbFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbSrc}
            alt={p.title || ''}
            loading="lazy"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <PlaylistPlaceholder />
        )}
        <div className="card-duration">
          {videoCount} video{videoCount !== 1 ? 's' : ''}
        </div>
      </div>
      <div className="card-body">
        <div className="card-highlight-tags">
          {highlights.map((t) => (
            <span className="card-tag" key={t}>
              {t}
            </span>
          ))}
        </div>
        <div className="card-title">{p.title || p._id}</div>
        <div className="card-authors">
          <span>
            <span className="card-author-label">Playlist by:</span>
            {p.author || 'Unknown'}
          </span>
        </div>
        <div className="card-meta">
          <div className="card-meta-item">
            <span>Videos</span>
            <span>{videoCount}</span>
          </div>
          {p.totalDurationSecs != null && (
            <div className="card-meta-item">
              <span>Runtime</span>
              <span>{secsToRuntime(p.totalDurationSecs)}</span>
            </div>
          )}
        </div>
      </div>
    </Link>
  )
}
