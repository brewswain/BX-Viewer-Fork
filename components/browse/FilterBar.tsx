'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { VideoMeta } from './VideoCard'

export const VIDEO_TYPES = ['BounceX', 'Dildo Hero', 'Other']
export const DIFFICULTIES = ['Easy', 'Medium', 'Hard', 'Extreme', 'Multi-Difficulty']
export const SONG_QUANTITY = ['Single Song', 'Compilation', 'No Song']

export const RESERVED_TAGS = new Set(
  [...VIDEO_TYPES, ...DIFFICULTIES, ...SONG_QUANTITY].map((t) => t.toLowerCase()),
)

export type FilterKey =
  | 'videoType'
  | 'difficulty'
  | 'songQuantity'
  | 'pathCreator'
  | 'videoCreator'
  | 'tags'

export type ActiveFilters = Record<FilterKey, Set<string>>

export function emptyFilters(): ActiveFilters {
  return {
    videoType: new Set<string>(),
    difficulty: new Set<string>(),
    songQuantity: new Set<string>(),
    pathCreator: new Set<string>(),
    videoCreator: new Set<string>(),
    tags: new Set<string>(),
  }
}

type Props = {
  videos: VideoMeta[]
  filters: ActiveFilters
  onChange: (next: ActiveFilters) => void
}

export default function FilterBar({ videos, filters, onChange }: Props) {
  const [openKey, setOpenKey] = useState<FilterKey | null>(null)
  const [tagSearch, setTagSearch] = useState('')
  const barRef = useRef<HTMLDivElement>(null)

  // Any click outside the bar closes every panel. Legacy relied on the bar
  // swallowing its own clicks via stopPropagation; a containment test is
  // equivalent and immune to React's document-level event delegation.
  useEffect(() => {
    const closeAll = (e: MouseEvent) => {
      if (barRef.current?.contains(e.target as Node)) return
      setOpenKey(null)
    }
    document.addEventListener('click', closeAll)
    return () => document.removeEventListener('click', closeAll)
  }, [])

  const groups = useMemo(() => {
    const pathCreators = [
      ...new Set(videos.map((v) => v.pathCreator).filter(Boolean) as string[]),
    ].sort()
    const videoCreators = [
      ...new Set(videos.map((v) => v.videoCreator).filter(Boolean) as string[]),
    ].sort()

    const tagCounts: Record<string, number> = {}
    videos.forEach((v) => {
      ;(v.tags || []).forEach((t) => {
        if (!RESERVED_TAGS.has(t.toLowerCase())) {
          tagCounts[t] = (tagCounts[t] || 0) + 1
        }
      })
    })
    const generalTags = Object.keys(tagCounts).sort()

    const defs: Array<{
      key: FilterKey
      label: string
      items: string[]
      searchable?: boolean
    }> = [
      { key: 'videoType', label: 'Video Type', items: VIDEO_TYPES },
      { key: 'difficulty', label: 'Difficulty', items: DIFFICULTIES },
      { key: 'songQuantity', label: 'Song Quantity', items: SONG_QUANTITY },
      { key: 'pathCreator', label: 'Path Creator', items: pathCreators },
      { key: 'videoCreator', label: 'Video Creator', items: videoCreators },
      { key: 'tags', label: 'Tags', items: generalTags, searchable: true },
    ]
    return defs
  }, [videos])

  function toggleItem(key: FilterKey, item: string, checked: boolean) {
    const set = new Set(filters[key])
    if (checked) set.add(item)
    else set.delete(item)
    onChange({ ...filters, [key]: set })
  }

  function resetGroup(key: FilterKey) {
    onChange({ ...filters, [key]: new Set<string>() })
  }

  const tagQuery = tagSearch.trim().toLowerCase()

  return (
    <div className="filter-bar" id="tagFilter" ref={barRef}>
      {groups.map(({ key, label, items, searchable }) => {
        const count = filters[key].size
        const open = openKey === key
        const visibleItems = searchable
          ? items.filter((item) => item.toLowerCase().includes(tagQuery))
          : items
        return (
          <div className="filter-dropdown-wrap" key={key}>
            <button
              className={`filter-btn${open ? ' open' : ''}${count > 0 ? ' has-active' : ''}`}
              id={`filter-btn-${key}`}
              onClick={() => setOpenKey(open ? null : key)}
            >
              {label}
              <span
                className={`filter-badge${count > 0 ? ' visible' : ''}`}
                id={`filter-badge-${key}`}
              >
                {count > 0 ? count : ''}
              </span>
              <svg
                className="filter-chevron"
                viewBox="0 0 10 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <polyline points="1,1 5,5 9,1" />
              </svg>
            </button>
            <div
              className={`filter-panel${open ? ' open' : ''}`}
              id={`filter-panel-${key}`}
            >
              <div className="filter-panel-header">
                <span className="filter-panel-title">{label}</span>
                <button
                  className="filter-panel-reset"
                  data-key={key}
                  onClick={() => resetGroup(key)}
                >
                  Reset
                </button>
              </div>
              {searchable && (
                <input
                  type="text"
                  className="filter-panel-search"
                  placeholder="Search tags…"
                  value={tagSearch}
                  onChange={(e) => setTagSearch(e.target.value)}
                />
              )}
              <div className="filter-check-list">
                {visibleItems.map((item) => (
                  <label className="filter-check-item" data-value={item} key={item}>
                    <input
                      type="checkbox"
                      value={item}
                      checked={filters[key].has(item)}
                      onChange={(e) => toggleItem(key, item, e.target.checked)}
                    />
                    {item}
                  </label>
                ))}
              </div>
            </div>
          </div>
        )
      })}
      <button className="filter-reset-all" onClick={() => onChange(emptyFilters())}>
        Reset All
      </button>
    </div>
  )
}
