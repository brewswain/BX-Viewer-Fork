'use client'

/** Full-screen "drop a .zip" hint shown while a file is dragged over the page. */
export function DropOverlay({ active }: { active: boolean }) {
  return (
    <div id="dropOverlay" className={active ? 'active' : undefined}>
      <div className="drop-zone-box">
        <div className="drop-zone-icon">
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <div className="drop-zone-label">Drop .zip to import</div>
        <div className="drop-zone-hint">
          Videos and playlists will be registered automatically
        </div>
      </div>
    </div>
  )
}

/** Spinner shown while a .zip import is in flight. */
export function ImportOverlay({
  active,
  message,
}: {
  active: boolean
  message: string
}) {
  return (
    <div id="importOverlay" className={active ? 'active' : undefined}>
      <div className="import-spinner"></div>
      <div className="import-status-text" id="importStatusText">
        {message}
      </div>
    </div>
  )
}

export type PendingDelete = { type: 'video' | 'playlist'; id: string }

export function ConfirmDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingDelete | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const typeLabel = pending?.type === 'video' ? 'video' : 'playlist'
  return (
    <div
      id="confirmOverlay"
      className={pending ? 'active' : undefined}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="confirm-box">
        <div className="confirm-icon">
          <svg
            width="18"
            height="18"
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
        </div>
        <div>
          <div className="confirm-title" id="confirmTitle">
            {pending ? `Delete ${typeLabel}?` : 'Delete?'}
          </div>
        </div>
        <div className="confirm-body" id="confirmBody">
          {pending ? (
            <>
              Folder <strong>{pending.id}</strong> and all its contents will be
              removed from your project.
            </>
          ) : null}
        </div>
        <div className="confirm-warning">
          This will permanently delete the folder and remove it from the
          manifest. This cannot be undone.
        </div>
        <div className="confirm-actions">
          <button className="confirm-cancel-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="confirm-delete-btn"
            id="confirmDeleteBtn"
            onClick={onConfirm}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            </svg>
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
