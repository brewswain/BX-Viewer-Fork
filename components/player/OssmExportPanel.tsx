'use client'

import { useEffect, useMemo, useState } from 'react'

import {
  downloadOssmBundle,
  installOssmExport,
  planOssmExport,
  summarizePlan,
} from '@/lib/ossm/client'
import type {
  OssmFileStatus,
  OssmInstallResult,
  OssmItem,
  OssmPlan,
  OssmRequest,
} from '@/lib/ossm/types'

/**
 * "Send this to OSSM Sauce" for the player sidebar.
 *
 * Two ways out: a zip shaped to extract over `<Documents>/OSSM Sauce/`, or a
 * direct install when the browser and the server are the same machine. Install
 * always goes through a plan first — it writes into the user's Documents
 * folder, and the plan is the only thing that makes that reviewable.
 */

type Props = {
  /** Resolved (videoId, bxFile) pairs, in playback order. */
  items: OssmItem[]
  /** Omit or null for a paths-only export — no `.bxpl` is written. */
  playlistTitle?: string | null
  /** Zip filename stem. */
  bundleName: string
  /** Tighter layout for the watch page's narrower sidebar. */
  compact?: boolean
}

type Busy = 'download' | 'plan' | 'install' | null

const STATUS_LABEL: Record<OssmFileStatus, string> = {
  new: 'new',
  identical: 'already there',
  renamed: 'renamed',
}

const RENAME_NOTE =
  'A different file already holds that name in Paths/, so this one takes a suffix. Nothing is overwritten.'

const STATUS_HINT: Record<OssmFileStatus, string> = {
  new: 'Will be written to Paths/.',
  identical: 'A byte-identical file is already in Paths/, so installing skips it.',
  renamed: RENAME_NOTE,
}

export default function OssmExportPanel({
  items,
  playlistTitle,
  bundleName,
  compact,
}: Props) {
  const [busy, setBusy] = useState<Busy>(null)
  const [plan, setPlan] = useState<OssmPlan | null>(null)
  const [result, setResult] = useState<OssmInstallResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const request = useMemo<OssmRequest>(
    () => ({ items, playlistTitle, bundleName }),
    [items, playlistTitle, bundleName],
  )

  // A plan describes one exact request. Switching track or .bx variant makes it
  // stale, and confirming a stale plan would install something the user is no
  // longer looking at — so throw it away whenever the request changes.
  const requestKey = useMemo(
    () =>
      JSON.stringify([
        items.map((i) => `${i.videoId}/${i.bxFile}`),
        playlistTitle ?? null,
        bundleName,
      ]),
    [items, playlistTitle, bundleName],
  )
  useEffect(() => {
    setPlan(null)
    setResult(null)
    setError(null)
  }, [requestKey])

  const empty = items.length === 0
  const disabled = empty || busy !== null

  async function onDownload() {
    setBusy('download')
    setError(null)
    try {
      await downloadOssmBundle(request)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function onPlan() {
    setBusy('plan')
    setError(null)
    setResult(null)
    try {
      setPlan(await planOssmExport(request))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function onConfirmInstall() {
    setBusy('install')
    setError(null)
    try {
      setResult(await installOssmExport(request))
      setPlan(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const renamedCount = plan?.files.filter((f) => f.status === 'renamed').length ?? 0

  return (
    <div className={`sidebar-section ossm-panel${compact ? ' ossm-panel-compact' : ''}`}>
      <div className="sidebar-title">OSSM Sauce</div>

      {empty ? (
        <p className="ossm-note">
          Nothing to export — no .bx path could be resolved for this
          {playlistTitle ? ' playlist' : ' video'}.
        </p>
      ) : (
        <p className="ossm-note">
          {items.length} path{items.length === 1 ? '' : 's'}
          {playlistTitle ? ' plus a .bxpl playlist' : ''}, named for OSSM Sauce&rsquo;s
          flat Paths folder.
        </p>
      )}

      <div className="ossm-actions">
        <button
          type="button"
          className="device-btn"
          onClick={onDownload}
          disabled={disabled}
        >
          {busy === 'download' ? 'Zipping…' : 'Download for OSSM Sauce'}
        </button>
        <button
          type="button"
          className="device-btn device-btn-primary"
          onClick={onPlan}
          disabled={disabled || plan !== null}
        >
          {busy === 'plan' ? 'Checking…' : 'Install to OSSM Sauce'}
        </button>
      </div>

      {error && <p className="ossm-note ossm-note-error">{error}</p>}

      {plan && (
        <div className="ossm-plan">
          <div className="ossm-plan-row">
            <span className="ossm-plan-label">Target</span>
            <span className="ossm-plan-path">
              {plan.target.dir ?? 'No OSSM Sauce folder found'}
            </span>
          </div>
          <div className="ossm-plan-summary">{summarizePlan(plan)}</div>
          {plan.playlist && (
            <div className="ossm-plan-row">
              <span className="ossm-plan-label">Playlist</span>
              <span className="ossm-plan-path">{plan.playlist.name}</span>
            </div>
          )}

          {plan.files.length > 0 && (
            <ul className="ossm-file-list">
              {plan.files.map((f) => (
                <li className="ossm-file" key={`${f.videoId}/${f.sourceFile}`}>
                  <span className="ossm-file-name" title={`${f.videoId} / ${f.sourceFile}`}>
                    {f.name}
                  </span>
                  <span
                    className={`ossm-file-status ossm-file-status-${f.status}`}
                    title={STATUS_HINT[f.status]}
                  >
                    {STATUS_LABEL[f.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* `renamed` reads like an overwrite until you know it isn't. */}
          {renamedCount > 0 && <p className="ossm-note ossm-note-warn">{RENAME_NOTE}</p>}

          {plan.warnings.map((w, i) => (
            <p className="ossm-note ossm-note-warn" key={i}>
              {w}
            </p>
          ))}

          {!plan.canInstall && (
            <p className="ossm-note ossm-note-warn">
              The viewer is open on another device, so an install would write to the
              machine running the server, not this one. Download the zip instead and
              extract it over your OSSM Sauce folder.
            </p>
          )}

          <div className="ossm-actions">
            {plan.canInstall && (
              <button
                type="button"
                className="device-btn device-btn-primary"
                onClick={onConfirmInstall}
                disabled={busy !== null}
              >
                {busy === 'install' ? 'Installing…' : 'Confirm install'}
              </button>
            )}
            <button
              type="button"
              className="device-btn"
              onClick={() => setPlan(null)}
              disabled={busy !== null}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="ossm-plan ossm-result">
          <div className="ossm-plan-row">
            <span className="ossm-plan-label">Installed</span>
            <span className="ossm-plan-path">{result.dir}</span>
          </div>
          <div className="ossm-plan-summary">
            {result.written.length} written
            {result.skipped.length > 0 && `, ${result.skipped.length} already there`}
            {result.playlist && `, playlist ${result.playlist}`}
          </div>
          {result.written.length > 0 && (
            <ul className="ossm-file-list">
              {result.written.map((name) => (
                <li className="ossm-file" key={name}>
                  <span className="ossm-file-name">{name}</span>
                  <span className="ossm-file-status ossm-file-status-new">written</span>
                </li>
              ))}
            </ul>
          )}
          {result.warnings.map((w, i) => (
            <p className="ossm-note ossm-note-warn" key={i}>
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
