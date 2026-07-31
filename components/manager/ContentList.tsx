'use client'

import { useState } from 'react'
import type { ItemType } from '@/lib/manager-client'

export type ItemRow = {
  id: string
  title: string
  sub: string
  search: string
  errors: string[]
  warnings: string[]
}

type Props = {
  listId: string
  type: ItemType
  /** `null` while the list is loading. */
  rows: ItemRow[] | null
  error: { msg: string; detail: string } | null
  emptyMessage: string
  errorMessage: string
  highlightIds: string[]
  query: string
  onReorder: (newOrder: string[]) => void
  onDelete: (id: string, displayName: string) => void
  onOpen: (id: string, displayName: string) => void
}

const DragHandleIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <circle cx="9" cy="5" r="1" fill="currentColor" />
    <circle cx="15" cy="5" r="1" fill="currentColor" />
    <circle cx="9" cy="12" r="1" fill="currentColor" />
    <circle cx="15" cy="12" r="1" fill="currentColor" />
    <circle cx="9" cy="19" r="1" fill="currentColor" />
    <circle cx="15" cy="19" r="1" fill="currentColor" />
  </svg>
)

const TrashIcon = (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
)

export default function ContentList({
  listId,
  type,
  rows,
  error,
  emptyMessage,
  errorMessage,
  highlightIds,
  query,
  onReorder,
  onDelete,
  onOpen,
}: Props) {
  // Items are only draggable while the handle is held down, matching the
  // legacy mousedown/mouseup dance on `.item-drag-handle`.
  const [draggableId, setDraggableId] = useState<string | null>(null)
  const [dragSrcId, setDragSrcId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const q = query.trim().toLowerCase()

  let body: React.ReactNode
  if (error) {
    body = (
      <div className="manager-state error">
        <svg
          width="36"
          height="36"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--red)"
          strokeWidth="1.2"
          opacity="0.5"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <p>{errorMessage}</p>
        {error.detail ? <div className="state-hint">{error.detail}</div> : null}
      </div>
    )
  } else if (rows === null) {
    body = <div className="manager-loading"></div>
  } else if (rows.length === 0) {
    body = (
      <div className="manager-state">
        <svg
          width="36"
          height="36"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          opacity="0.25"
        >
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
        <p>{emptyMessage}</p>
      </div>
    )
  } else {
    body = rows.map((row, i) => {
      const pills = [
        ...row.errors.map((e) => ({ cls: 'error', text: e })),
        ...row.warnings.map((w) => ({ cls: 'warning', text: w })),
      ]
      const hidden = !(!q || row.search.includes(q))
      const cls = [
        'content-item',
        highlightIds.includes(row.id) ? 'item-new' : '',
        hidden ? 'list-item-hidden' : '',
        dragSrcId === row.id ? 'dragging' : '',
        dragOverId === row.id ? 'drag-over' : '',
      ]
        .filter(Boolean)
        .join(' ')

      return (
        <div
          key={row.id}
          className={cls}
          style={{ animationDelay: `${i * 0.02}s` }}
          draggable={draggableId === row.id}
          data-id={row.id}
          data-type={type}
          data-search={row.search}
          onDragStart={(e) => {
            setDragSrcId(row.id)
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', row.id)
          }}
          onDragEnd={() => {
            setDraggableId(null)
            setDragSrcId(null)
            setDragOverId(null)
          }}
          onDragOver={(e) => {
            if (!dragSrcId || dragSrcId === row.id) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDragOverId(row.id)
          }}
          onDragLeave={() => {
            setDragOverId((prev) => (prev === row.id ? null : prev))
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDragOverId(null)
            if (!dragSrcId || dragSrcId === row.id) return
            const ids = rows.map((r) => r.id)
            const fromIdx = ids.indexOf(dragSrcId)
            const toIdx = ids.indexOf(row.id)
            if (fromIdx === -1 || toIdx === -1) return
            const [moved] = ids.splice(fromIdx, 1)
            ids.splice(toIdx, 0, moved)
            onReorder(ids)
          }}
          onClick={() => onOpen(row.id, row.title)}
        >
          <div
            className="item-drag-handle"
            title="Drag to reorder"
            onMouseDown={() => setDraggableId(row.id)}
            onMouseUp={() => setDraggableId(null)}
          >
            {DragHandleIcon}
          </div>
          <div className="item-index">{String(i + 1).padStart(2, '0')}</div>
          <div className="item-body">
            <div className="item-title">{row.title}</div>
            <div className="item-sub">{row.sub}</div>
          </div>
          {pills.length > 0 ? (
            <div className="item-pills">
              {pills.map((p, pi) => (
                <span className={`item-pill ${p.cls}`} key={pi}>
                  {p.text}
                </span>
              ))}
            </div>
          ) : null}
          <button
            className="item-delete-btn"
            title={type === 'video' ? 'Delete video' : 'Delete playlist'}
            onClick={(e) => {
              e.stopPropagation()
              onDelete(row.id, row.title)
            }}
          >
            {TrashIcon}
          </button>
        </div>
      )
    })
  }

  return (
    <div className="content-list" id={listId}>
      {body}
    </div>
  )
}
