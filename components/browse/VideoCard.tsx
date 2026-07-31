'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

export type VideoMeta = {
  /** Manifest folder id, stamped on at fetch time (legacy `_folder`). */
  _folder?: string
  videoId?: string
  title?: string
  videoFile?: string
  thumbnail?: string
  /** Legacy duration, in frames @60fps. */
  duration?: number
  durationSecs?: number
  bpm?: number | string
  pathCreator?: string
  videoCreator?: string
  description?: string
  tags?: string[]
  highlightedTags?: string[]
  bxFiles?: Array<{ label: string; file: string }>
}

export function framesToTimecode(frames: number, fps = 60): string {
  const secs = Math.floor(frames / fps)
  const mm = String(Math.floor(secs / 60)).padStart(2, '0')
  const ss = String(secs % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

export function secsToTimecode(secs: number): string {
  const s = Math.floor(secs)
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

export function ThumbPlaceholder() {
  return (
    <div className="card-thumb-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polygon points="5,3 19,12 5,21" />
      </svg>
    </div>
  )
}

export default function VideoCard({ video, index }: { video: VideoMeta; index: number }) {
  const folder = video._folder || video.videoId || ''
  const thumbSrc = video.thumbnail
    ? `/videos/${encodeURIComponent(folder)}/${encodeURIComponent(video.thumbnail)}`
    : null
  // Prefer durationSecs (stored at create time) → legacy duration in frames → probe
  const timecode =
    video.durationSecs != null
      ? secsToTimecode(video.durationSecs)
      : video.duration
        ? framesToTimecode(video.duration)
        : null

  const highlights = (video.highlightedTags || []).slice(0, 3)

  const [thumbFailed, setThumbFailed] = useState(false)
  const [probedTimecode, setProbedTimecode] = useState<string | null>(null)

  // If duration wasn't in meta.json, probe the video file for it
  useEffect(() => {
    if (timecode) return
    const videoFile = video.videoFile || `${folder}.mp4`
    const videoSrc = `/videos/${encodeURIComponent(folder)}/${encodeURIComponent(videoFile)}`
    const probe = document.createElement('video')
    probe.preload = 'metadata'
    probe.muted = true
    probe.style.display = 'none'
    probe.addEventListener(
      'loadedmetadata',
      () => {
        if (probe.duration && isFinite(probe.duration)) {
          setProbedTimecode(secsToTimecode(probe.duration))
        }
        probe.src = ''
        probe.remove()
      },
      { once: true },
    )
    probe.addEventListener(
      'error',
      () => {
        probe.src = ''
        probe.remove()
      },
      { once: true },
    )
    probe.src = videoSrc
    return () => {
      probe.src = ''
      probe.remove()
    }
  }, [folder, timecode, video.videoFile])

  return (
    <Link
      className="video-card"
      href={`/watch?v=${encodeURIComponent(folder)}`}
      style={{ animationDelay: `${index * 0.04}s` }}
    >
      <div className="card-thumb">
        {thumbSrc && !thumbFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbSrc}
            alt={video.title || ''}
            loading="lazy"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <ThumbPlaceholder />
        )}
      </div>
      <div className="card-body">
        <div className="card-highlight-tags">
          {highlights.map((t) => (
            <span className="card-tag" key={t}>
              {t}
            </span>
          ))}
        </div>
        <div className="card-title">{video.title || folder}</div>
        <div className="card-authors">
          <span>
            <span className="card-author-label">Video by:</span>
            {video.videoCreator || 'Unknown'}
          </span>
          <span>
            <span className="card-author-label">Path by:</span>
            {video.pathCreator || 'Unknown'}
          </span>
        </div>
        <div className="card-meta">
          <div className="card-meta-item">
            <span>BPM</span>
            <span>{video.bpm || '—'}</span>
          </div>
          <div className="card-meta-item">
            <span>Duration</span>
            <span className="card-duration-meta">
              {timecode || probedTimecode || '—'}
            </span>
          </div>
        </div>
      </div>
    </Link>
  )
}
