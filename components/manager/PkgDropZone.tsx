'use client'

import { useRef, useState } from 'react'

/**
 * `hintVisible` is tracked separately from `hasFile` because edit mode re-shows
 * the hint ("Drop a new file to replace…") on a filled zone, and `hintText`
 * deliberately survives a later clear.
 */
export type ZoneState = {
  hasFile: boolean
  filename: string
  preview: string
  hintText: string
  hintVisible: boolean
}

export function emptyZone(hintText: string): ZoneState {
  return { hasFile: false, filename: '', preview: '', hintText, hintVisible: true }
}

/** setDropZoneEmpty(): note it never restored the label/hint *text*. */
export function clearZone(z: ZoneState): ZoneState {
  return { ...z, hasFile: false, filename: '', preview: '', hintVisible: true }
}

export function fillZone(z: ZoneState, filename: string, preview = ''): ZoneState {
  return { ...z, hasFile: true, filename, preview, hintVisible: false }
}

export function replaceHint(z: ZoneState): ZoneState {
  return {
    ...z,
    hintText: 'Drop a new file to replace · click to browse',
    hintVisible: true,
  }
}

type Props = {
  zoneId: string
  inputId: string
  accept: string
  labelId: string
  labelText: string
  hintId: string
  filenameId: string
  clearId: string
  previewId?: string
  icon: React.ReactNode
  state: ZoneState
  requiredMissing?: boolean
  onPick: (file: File) => void
  onClear: () => void
}

export default function PkgDropZone({
  zoneId,
  inputId,
  accept,
  labelId,
  labelText,
  hintId,
  filenameId,
  clearId,
  previewId,
  icon,
  state,
  requiredMissing,
  onPick,
  onClear,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const zoneRef = useRef<HTMLDivElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const cls = [
    'pkg-drop-zone',
    state.hasFile ? 'has-file' : '',
    dragOver ? 'drag-over' : '',
    requiredMissing ? 'required-missing' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={zoneRef}
      className={cls}
      id={zoneId}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (!zoneRef.current?.contains(e.relatedTarget as Node | null))
          setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOver(false)
        const f = e.dataTransfer.files[0]
        if (f) onPick(f)
      }}
    >
      <input
        ref={inputRef}
        type="file"
        id={inputId}
        accept={accept}
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onPick(f)
          e.target.value = ''
        }}
      />
      {previewId ? (
        <img
          className="pkg-drop-preview"
          id={previewId}
          alt=""
          src={state.preview}
        />
      ) : null}
      <div className="pkg-drop-icon">{icon}</div>
      <div
        className="pkg-drop-label"
        id={labelId}
        style={state.hasFile ? { display: 'none' } : undefined}
      >
        {labelText}
      </div>
      <div
        className="pkg-drop-hint"
        id={hintId}
        style={state.hintVisible ? undefined : { display: 'none' }}
      >
        {state.hintText}
      </div>
      <div
        className="pkg-drop-filename"
        id={filenameId}
        style={state.hasFile ? undefined : { display: 'none' }}
      >
        {state.filename}
      </div>
      <button
        className="pkg-drop-clear"
        id={clearId}
        title="Remove"
        onClick={(e) => {
          e.stopPropagation()
          onClear()
        }}
      >
        ✕
      </button>
    </div>
  )
}
