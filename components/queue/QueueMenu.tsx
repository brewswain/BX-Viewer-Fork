'use client'

/**
 * The "..." button on a video: add to queue, play next, add to a playlist, or
 * open the queue. The menu is portalled to <body> with fixed positioning,
 * because cards clip their overflow and sit inside a link.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { addNext, addToEnd, addToQueue } from '@/lib/queue/store'
import { addToPlaylist, listPlaylistChoices, type PlaylistChoice } from '@/lib/queue/playlists'
import type { QueueVideo } from '@/lib/queue/queue'
import { setQueueDrawerOpen } from './queueUi'

type Props = { video: QueueVideo; className?: string }

type Picker =
  | { state: 'closed' }
  | { state: 'loading' }
  | { state: 'ready'; choices: PlaylistChoice[] }
  | { state: 'error'; message: string }

const MENU_W = 220

export default function QueueMenu({ video, className }: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [picker, setPicker] = useState<Picker>({ state: 'closed' })
  const [flash, setFlash] = useState<string | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8))
    setPos({ top: r.bottom + 4, left })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    // Scrolling would leave a fixed menu floating away from its button.
    const onScroll = () => setOpen(false)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 1600)
    return () => clearTimeout(t)
  }, [flash])

  // The card around the button is a link; nothing in here may navigate it.
  function stop(e: React.SyntheticEvent) {
    e.preventDefault()
    e.stopPropagation()
  }

  function done(message: string) {
    setOpen(false)
    setPicker({ state: 'closed' })
    setFlash(message)
  }

  async function openPicker() {
    setPicker({ state: 'loading' })
    try {
      setPicker({ state: 'ready', choices: await listPlaylistChoices() })
    } catch (e) {
      setPicker({ state: 'error', message: (e as Error).message })
    }
  }

  async function pick(choice: PlaylistChoice) {
    try {
      const added = await addToPlaylist(choice.id, video.folder)
      done(added ? `Added to ${choice.title}` : `Already in ${choice.title}`)
    } catch (e) {
      setPicker({ state: 'error', message: (e as Error).message })
    }
  }

  const menu =
    open && pos
      ? createPortal(
          <div
            className="queue-menu"
            ref={menuRef}
            role="menu"
            style={{ top: pos.top, left: pos.left, width: MENU_W }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              role="menuitem"
              onClick={() => {
                addToQueue(video)
                done('Added to queue')
              }}
            >
              Add to queue
            </button>
            <button
              role="menuitem"
              onClick={() => {
                addNext(video)
                done('Playing next')
              }}
            >
              Play next
            </button>
            <button
              role="menuitem"
              onClick={() => {
                addToEnd(video)
                done('Added to end')
              }}
            >
              Add to end of queue
            </button>
            <button
              role="menuitem"
              aria-expanded={picker.state !== 'closed'}
              onClick={() =>
                picker.state === 'closed' ? void openPicker() : setPicker({ state: 'closed' })
              }
            >
              Add to playlist {picker.state === 'closed' ? '›' : '⌄'}
            </button>
            {picker.state === 'loading' && <div className="queue-menu-note">Loading playlists…</div>}
            {picker.state === 'error' && (
              <div className="queue-menu-note error">{picker.message}</div>
            )}
            {picker.state === 'ready' && (
              <div className="queue-menu-sub">
                {picker.choices.length === 0 && (
                  <div className="queue-menu-note">No playlists yet.</div>
                )}
                {picker.choices.map((c) => (
                  <button role="menuitem" key={c.id} onClick={() => void pick(c)}>
                    {c.title}
                  </button>
                ))}
              </div>
            )}
            <div className="queue-menu-sep" />
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false)
                setQueueDrawerOpen(true)
              }}
            >
              View queue
            </button>
          </div>,
          document.body,
        )
      : null

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`queue-menu-btn${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
        title="More: add to queue, play next, add to playlist"
        aria-label="More options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          stop(e)
          setOpen((o) => !o)
          setPicker({ state: 'closed' })
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {flash ? (
          <span className="queue-menu-flash">{flash}</span>
        ) : (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        )}
      </button>
      {menu}
    </>
  )
}
