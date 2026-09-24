'use client'

import { useMemo } from 'react'
import { FACETS, extraTags, tagLabel, type MatchMode } from '@/lib/browse/facets'

type Props = {
  /** The list the buttons filter, used for counts and to hide empty tags. */
  entries: { tags?: string[] }[]
  selected: string[]
  mode: MatchMode
  onChange: (selected: string[], mode: MatchMode) => void
  /** Back to the saved default; omitted where there is none (playlists). */
  onDefault?: () => void
  onSaveDefault?: () => void
}

export default function TagSidebar({
  entries,
  selected,
  mode,
  onChange,
  onDefault,
  onSaveDefault,
}: Props) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const e of entries) for (const t of e.tags ?? []) c[t] = (c[t] || 0) + 1
    return c
  }, [entries])

  const rows = useMemo(() => {
    const extra = extraTags(entries)
    const facets = extra.length ? [...FACETS, { key: 'other', label: 'Other', tags: extra }] : FACETS
    return facets
      .map((f) => ({ ...f, tags: f.tags.filter((t) => counts[t] || selected.includes(t)) }))
      .filter((f) => f.tags.length > 0)
  }, [entries, counts, selected])

  function toggle(tag: string) {
    onChange(
      selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag],
      mode,
    )
  }

  return (
    <aside className="tag-sidebar" aria-label="Filter by tag">
      <div className="tag-sidebar-head">
        <div className="tag-mode" role="radiogroup" aria-label="Combine selected tags">
          {(['or', 'and'] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              className={`tag-mode-btn${mode === m ? ' active' : ''}`}
              title={m === 'or' ? 'Match any selected tag' : 'Match every selected tag'}
              onClick={() => onChange(selected, m)}
            >
              {m === 'or' ? 'Any' : 'All'}
            </button>
          ))}
        </div>
        <button
          className="tag-sidebar-link"
          disabled={selected.length === 0}
          onClick={() => onChange([], mode)}
        >
          Clear
        </button>
      </div>

      {rows.map((f) => (
        <div className="tag-facet" key={f.key}>
          <div className="tag-facet-label">{f.label}</div>
          <div className="tag-facet-btns">
            {f.tags.map((t) => {
              const on = selected.includes(t)
              return (
                <button
                  key={t}
                  className={`tag-btn${on ? ' active' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggle(t)}
                >
                  {tagLabel(t)}
                  <span className="tag-btn-count">{counts[t] ?? 0}</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}

      {(onDefault || onSaveDefault) && (
        <div className="tag-sidebar-foot">
          {onDefault && (
            <button className="tag-sidebar-link" onClick={onDefault}>
              Reset to default
            </button>
          )}
          {onSaveDefault && (
            <button className="tag-sidebar-link" onClick={onSaveDefault}>
              Save as default
            </button>
          )}
        </div>
      )}
    </aside>
  )
}
