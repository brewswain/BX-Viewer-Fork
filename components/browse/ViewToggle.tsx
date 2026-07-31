'use client'

export type ViewMode = 'grid' | 'list'

type Props = {
  mode: ViewMode
  onChange: (mode: ViewMode) => void
  gridBtnId: string
  listBtnId: string
}

export default function ViewToggle({ mode, onChange, gridBtnId, listBtnId }: Props) {
  return (
    <div className="view-toggle" aria-label="Switch view">
      <button
        className={`view-toggle-btn${mode === 'grid' ? ' active' : ''}`}
        id={gridBtnId}
        title="Grid view"
        aria-pressed={mode === 'grid'}
        onClick={() => onChange('grid')}
      >
        <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
          <rect x="1" y="1" width="6" height="6" rx="1" />
          <rect x="9" y="1" width="6" height="6" rx="1" />
          <rect x="1" y="9" width="6" height="6" rx="1" />
          <rect x="9" y="9" width="6" height="6" rx="1" />
        </svg>
      </button>
      <button
        className={`view-toggle-btn${mode === 'list' ? ' active' : ''}`}
        id={listBtnId}
        title="List view"
        aria-pressed={mode === 'list'}
        onClick={() => onChange('list')}
      >
        <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
          <rect x="1" y="2" width="14" height="3" rx="1" />
          <rect x="1" y="7" width="14" height="3" rx="1" />
          <rect x="1" y="12" width="14" height="3" rx="1" />
        </svg>
      </button>
    </div>
  )
}
