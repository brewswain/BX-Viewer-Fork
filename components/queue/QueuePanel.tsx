'use client'

/**
 * The queue as a list: now playing, next up, and what already played. Drag a
 * row to reorder, × to remove, click to play from there.
 *
 * `onPlay` is the queue player's own track loader; everywhere else a click
 * opens the queue player at that row.
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { secsToTimecode, ThumbPlaceholder } from '@/components/browse/VideoCard'
import { tagLabel } from '@/lib/browse/facets'
import { currentIndex, type QueueItem } from '@/lib/queue/queue'
import { saveQueueAsPlaylist } from '@/lib/queue/playlists'
import {
  clearQueue,
  moveInQueue,
  playStartUid,
  queueHref,
  removeFromQueue,
  useQueue,
} from '@/lib/queue/store'
import { difficultyOf } from './queueUi'
import RadioSection from './RadioSection'

type Props = {
  onPlay?: (uid: string) => void
  /** Hide the Play button: the page is already the queue player. */
  isPlayer?: boolean
}

type SaveState =
  | { state: 'idle' }
  | { state: 'editing'; title: string; error?: string }
  | { state: 'saving'; title: string }
  | { state: 'saved'; id: string; title: string }

export default function QueuePanel({ onPlay, isPlayer = false }: Props) {
  const queue = useQueue()
  const router = useRouter()
  const [save, setSave] = useState<SaveState>({ state: 'idle' })
  const [dragUid, setDragUid] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [showPlayed, setShowPlayed] = useState(false)

  const { items } = queue
  const cur = currentIndex(queue)
  // Only when every row knows its length: a partial sum reads as a wrong total.
  const totalSecs = items.every((i) => i.durationSecs != null)
    ? items.reduce((s, i) => s + (i.durationSecs ?? 0), 0)
    : 0

  function play(uid: string) {
    if (onPlay) onPlay(uid)
    else router.push(queueHref(uid))
  }

  async function submitSave(title: string) {
    if (!title.trim()) return
    setSave({ state: 'saving', title })
    try {
      const id = await saveQueueAsPlaylist(
        title,
        items.map((i) => i.folder),
      )
      setSave({ state: 'saved', id, title })
    } catch (e) {
      setSave({ state: 'editing', title, error: (e as Error).message })
    }
  }

  function onDrop() {
    if (dragUid && dropAt != null) {
      const from = items.findIndex((i) => i.uid === dragUid)
      // `dropAt` is a gap index in the list as drawn; removing the dragged row
      // first shifts every gap after it up by one.
      moveInQueue(dragUid, from >= 0 && from < dropAt ? dropAt - 1 : dropAt)
    }
    setDragUid(null)
    setDropAt(null)
  }

  function row(item: QueueItem, index: number) {
    const state = index === cur ? 'now' : index < cur ? 'played' : 'next'
    const diff = difficultyOf(item.tags)
    const thumb = item.thumbnail
      ? `/videos/${encodeURIComponent(item.folder)}/${encodeURIComponent(item.thumbnail)}`
      : null
    return (
      <div
        key={item.uid}
        className={`queue-row ${state}${dragUid === item.uid ? ' dragging' : ''}${
          dropAt === index ? ' drop-before' : ''
        }${dropAt === items.length && index === items.length - 1 ? ' drop-after' : ''}`}
        draggable
        onDragStart={(e) => {
          setDragUid(item.uid)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={(e) => {
          if (!dragUid) return
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          setDropAt(e.clientY < r.top + r.height / 2 ? index : index + 1)
        }}
        onDrop={(e) => {
          e.preventDefault()
          onDrop()
        }}
        onDragEnd={() => {
          setDragUid(null)
          setDropAt(null)
        }}
        onClick={() => play(item.uid)}
        title={state === 'now' ? 'Now playing' : 'Play from here'}
      >
        <div className="queue-row-thumb">
          {thumb ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={thumb} alt="" loading="lazy" />
          ) : (
            <ThumbPlaceholder />
          )}
        </div>
        <div className="queue-row-info">
          <div className="queue-row-title">{item.title || item.folder}</div>
          <div className="queue-row-meta">
            {item.radio && (
              <span className="queue-radio" title="Picked by radio">
                Radio · {item.radio.phase}
              </span>
            )}
            {diff &&<span className={`queue-diff diff-${diff}`}>{tagLabel(diff)}</span>}
            {item.durationSecs != null && <span>{secsToTimecode(item.durationSecs)}</span>}
          </div>
        </div>
        {state !== 'now' && (
          <button
            className="queue-row-remove"
            title="Remove from queue"
            aria-label="Remove from queue"
            onClick={(e) => {
              e.stopPropagation()
              removeFromQueue(item.uid)
            }}
          >
            ×
          </button>
        )}
      </div>
    )
  }

  const nowRows = cur >= 0 ? [row(items[cur], cur)] : []
  // Hand-added rows lead, then the rest of what the queue was started from,
  // matching the order they play in.
  const next = items.slice(cur + 1)
  const addedCount = next.findIndex((it) => !it.added)
  const splitAt = addedCount < 0 ? next.length : addedCount
  const addedRows = next.slice(0, splitAt).map((it, i) => row(it, cur + 1 + i))
  const restRows = next.slice(splitAt).map((it, i) => row(it, cur + 1 + splitAt + i))
  const playedRows = items.slice(0, Math.max(cur, 0)).map((it, i) => row(it, i))
  const startUid = playStartUid(queue)

  return (
    <div className="queue-panel">
      <div className="queue-head">
        <div className="queue-count">
          {items.length === 0
            ? 'Queue is empty'
            : `${items.length} ${items.length === 1 ? 'video' : 'videos'}${
                totalSecs > 0 ? ` · ${Math.round(totalSecs / 60)} min` : ''
              }`}
        </div>
        <div className="queue-actions">
          {!isPlayer && startUid && (
            <button className="queue-btn primary" onClick={() => play(startUid)}>
              Play
            </button>
          )}
          {items.length > 0 && (
            <button
              className="queue-btn"
              onClick={() =>
                setSave({ state: 'editing', title: save.state === 'editing' ? save.title : '' })
              }
            >
              Save as playlist
            </button>
          )}
          {items.length > 0 &&
            (confirmClear ? (
              <>
                <button
                  className="queue-btn danger"
                  onClick={() => {
                    clearQueue()
                    setConfirmClear(false)
                  }}
                >
                  Clear all
                </button>
                <button className="queue-btn" onClick={() => setConfirmClear(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button className="queue-btn" onClick={() => setConfirmClear(true)}>
                Clear
              </button>
            ))}
        </div>
      </div>

      {(save.state === 'editing' || save.state === 'saving') && (
        <form
          className="queue-save"
          onSubmit={(e) => {
            e.preventDefault()
            void submitSave(save.title)
          }}
        >
          <input
            autoFocus
            placeholder="Playlist name"
            value={save.title}
            disabled={save.state === 'saving'}
            onChange={(e) => setSave({ state: 'editing', title: e.target.value })}
          />
          <button className="queue-btn primary" disabled={save.state === 'saving' || !save.title.trim()}>
            {save.state === 'saving' ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="queue-btn" onClick={() => setSave({ state: 'idle' })}>
            Cancel
          </button>
          {save.state === 'editing' && save.error && (
            <div className="queue-save-error">{save.error}</div>
          )}
        </form>
      )}
      {save.state === 'saved' && (
        <div className="queue-save-done">
          Saved as{' '}
          <Link href={`/playlist?p=${encodeURIComponent(save.id)}`}>{save.title}</Link>.
          <button className="queue-btn" onClick={() => setSave({ state: 'idle' })}>
            OK
          </button>
        </div>
      )}

      <RadioSection play={play} isPlayer={isPlayer} />

      {items.length === 0 ? (
        <p className="queue-empty">
          Use the ⋯ button on any video to add it here. The queue is shared by every tab, and
          it keeps what you built after it finishes.
        </p>
      ) : (
        <div
          className="queue-list"
          onDragOver={(e) => dragUid && e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            onDrop()
          }}
        >
          {/* Queue order top to bottom, so a drag lands where it looks like
              it will. History is folded away because it grows every track. */}
          {playedRows.length > 0 && (
            <button className="queue-section toggle" onClick={() => setShowPlayed((s) => !s)}>
              Played ({playedRows.length}) {showPlayed ? '⌄' : '›'}
            </button>
          )}
          {showPlayed && playedRows}
          {nowRows.length > 0 && <div className="queue-section">Now playing</div>}
          {nowRows}
          {addedRows.length > 0 && <div className="queue-section">Next in queue</div>}
          {addedRows}
          {restRows.length > 0 && (
            <div className="queue-section">
              {queue.source ? `Next from: ${queue.source}` : addedRows.length ? 'Then' : 'Next up'}
            </div>
          )}
          {restRows}
        </div>
      )}
    </div>
  )
}
