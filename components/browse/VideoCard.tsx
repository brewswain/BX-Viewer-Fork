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

/**
 * Above this many bytes, a card's duration is not worth a second reader of the
 * file. The player's `previewWorthBuilding` refuses on duration for the same
 * reason (see `lib/player/seekPreview.ts`); a probe cannot use that test,
 * because the duration is the thing it is asking for. File length is the bound
 * it can get, and 1.5 GB is the same line in those units: about 20 minutes at
 * the library's ~10 Mbps. A length that does not parse is refused rather than
 * guessed, since the cost of guessing wrong is every media element in the tab
 * wedged until a full page load.
 */
const PROBE_MAX_BYTES = 1536 * 1024 * 1024

/** A probe that never reports must not hold the queue behind it forever. */
const PROBE_TIMEOUT_MS = 15_000

/**
 * One duration probe in flight for the whole grid.
 *
 * Firefox's media cache is one budget per content process, so 72 cards probing
 * in parallel is 72 readers against it however small each file is. The chain is
 * module-level because that is the only scope that spans cards mounting and
 * unmounting; a card that unmounted still takes its turn, finds its cancel flag
 * set and returns without touching the network.
 */
let probeChain: Promise<unknown> = Promise.resolve()

function queueProbe(job: () => Promise<void>) {
  probeChain = probeChain.then(job, job)
}

/** Open a metadata-only element on `src` and read the duration back off it. */
function readDurationSecs(src: string): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = document.createElement('video')
    probe.preload = 'metadata'
    probe.muted = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = (secs: number | null) => {
      if (timer) clearTimeout(timer)
      probe.removeEventListener('loadedmetadata', onMetadata)
      probe.removeEventListener('error', onError)
      /**
       * Drops the decoder and cancels the range request, the same teardown the
       * engine's `teardownPreview` uses. `src = ''` resolves against the page
       * URL, which sets the element loading the browse page's own HTML as
       * media: a spurious request, a `MEDIA_ERR_SRC_NOT_SUPPORTED`, and no
       * reliable release of the cache blocks it was holding.
       */
      probe.removeAttribute('src')
      probe.load()
      resolve(secs)
    }
    const onMetadata = () =>
      done(Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : null)
    const onError = () => done(null)
    probe.addEventListener('loadedmetadata', onMetadata, { once: true })
    probe.addEventListener('error', onError, { once: true })
    timer = setTimeout(() => done(null), PROBE_TIMEOUT_MS)
    probe.src = src
  })
}

/** `null` for anything the card cannot show is safe to open a second time. */
async function probeDurationSecs(src: string): Promise<number | null> {
  let length: number
  try {
    const head = await fetch(src, { method: 'HEAD' })
    if (!head.ok) return null
    length = Number(head.headers.get('content-length'))
  } catch {
    return null
  }
  // A missing or unparseable header reads as 0 here, which is refused with the
  // oversized ones.
  if (!Number.isFinite(length) || length <= 0 || length > PROBE_MAX_BYTES) return null
  return readDurationSecs(src)
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

  // If duration wasn't in meta.json, probe the video file for it. The early
  // return is what keeps the 71 cards that carry a duration from ever reaching
  // the queue, let alone an element.
  useEffect(() => {
    if (timecode) return
    const videoFile = video.videoFile || `${folder}.mp4`
    const videoSrc = `/videos/${encodeURIComponent(folder)}/${encodeURIComponent(videoFile)}`
    let cancelled = false
    queueProbe(async () => {
      if (cancelled) return
      const secs = await probeDurationSecs(videoSrc)
      if (!cancelled && secs !== null) setProbedTimecode(secsToTimecode(secs))
    })
    return () => {
      cancelled = true
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
