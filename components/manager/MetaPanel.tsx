'use client'

import { useEffect, useRef, useState } from 'react'
import {
  errMessage,
  fetchMeta,
  metaUrl,
  sectionOf,
  type ItemType,
} from '@/lib/manager-client'
import type { ToastData } from './Toast'

export type MetaContext = { type: ItemType; id: string; displayName: string }

type Props = {
  context: MetaContext | null
  onClose: () => void
  showToast: (
    type: ToastData['type'],
    title: string,
    body: ToastData['body'],
  ) => void
  onSaved: (type: ItemType) => void
}

/**
 * Raw meta.json editor that slides in from the right.
 *
 * Not currently reachable from the UI — clicking a row opens the structured
 * editor instead. Kept for editing fields that editor doesn't expose.
 */
export default function MetaPanel({
  context,
  onClose,
  showToast,
  onSaved,
}: Props) {
  const [text, setText] = useState('')
  const [saveDisabled, setSaveDisabled] = useState(true)
  const [error, setError] = useState('')
  const [invalid, setInvalid] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!context) return
    let cancelled = false
    setText('Loading…')
    setInvalid(false)
    setError('')
    setSaveDisabled(true)
    ;(async () => {
      try {
        const data = await fetchMeta<unknown>(sectionOf(context.type), context.id)
        if (cancelled) return
        setText(JSON.stringify(data, null, 2))
        setSaveDisabled(false)
      } catch (e) {
        if (cancelled) return
        setText('')
        setError(`Failed to load meta.json: ${errMessage(e)}`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [context])

  async function saveMeta() {
    if (!context) return
    const { type, id } = context
    const raw = textRef.current?.value ?? text

    try {
      JSON.parse(raw)
    } catch (e) {
      setInvalid(true)
      setError(`Invalid JSON: ${errMessage(e)}`)
      return
    }

    setInvalid(false)
    setError('')
    setSaveDisabled(true)

    try {
      const res = await fetch(metaUrl(sectionOf(type), id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw,
        cache: 'no-store',
      })
      const result = await res.json()
      if (result.error) throw new Error(result.error)
      setSaveDisabled(false)
      showToast('success', 'Saved', `meta.json updated for "${id}"`)
      onSaved(type)
    } catch (e) {
      setSaveDisabled(false)
      setError(`Save failed: ${errMessage(e)}`)
    }
  }

  const active = context != null

  return (
    <>
      <div
        id="metaBackdrop"
        className={active ? 'active' : undefined}
        onClick={onClose}
      ></div>

      <div id="metaPanel" className={active ? 'active' : undefined}>
        <div className="meta-panel-header">
          <button className="meta-panel-close" onClick={onClose}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <div className="meta-panel-title">
            <div className="meta-panel-name" id="metaPanelName">
              {context?.displayName ?? ''}
            </div>
            <div className="meta-panel-sub" id="metaPanelSub">
              {context ? `${sectionOf(context.type)}/${context.id}/meta.json` : ''}
            </div>
          </div>
          <button
            className="meta-panel-save-btn"
            id="metaSaveBtn"
            disabled={saveDisabled}
            onClick={saveMeta}
          >
            Save
          </button>
        </div>
        <div className="meta-panel-body">
          <div
            className={'meta-json-error' + (error ? ' visible' : '')}
            id="metaJsonError"
          >
            {error}
          </div>
          <textarea
            ref={textRef}
            className={'meta-textarea' + (invalid ? ' invalid' : '')}
            id="metaTextarea"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                e.preventDefault()
                const ta = e.currentTarget
                const start = ta.selectionStart
                const end = ta.selectionEnd
                const next = ta.value.slice(0, start) + '  ' + ta.value.slice(end)
                setText(next)
                requestAnimationFrame(() => {
                  ta.selectionStart = ta.selectionEnd = start + 2
                })
              }
              if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault()
                void saveMeta()
              }
            }}
          ></textarea>
        </div>
      </div>
    </>
  )
}
