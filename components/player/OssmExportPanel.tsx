'use client'

import { useEffect, useMemo, useState } from 'react'

import {
  checkOssmApp,
  resolveOssmAppUrl,
  sendOssmPayload,
  sendOssmPlaylist,
  summarizeSend,
} from '@/lib/ossm/app'
import {
  downloadOssmBundle,
  fetchOssmPayload,
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
  OssmSendResult,
} from '@/lib/ossm/types'
import { getSettings, setSettings } from '@/lib/settings'

/**
 * "Send this to OSSM Sauce" for the player sidebar.
 *
 * Three ways out:
 *
 *  - **Download** a zip shaped to extract over `<Documents>/OSSM Sauce/`;
 *  - **Install**, which writes into that folder directly — but on the machine
 *    running the *server*, so it is offered only on loopback;
 *  - **Send to the app**, which posts the content to OSSM Sauce's own HTTP
 *    server from this browser (`lib/ossm/app.ts`). That is the one that works
 *    from a phone, and the one that survives a custom paths folder, because the
 *    app does the write and picks the folder itself.
 *
 * Install always goes through a plan first — it writes into the user's Documents
 * folder, and the plan is the only thing that makes that reviewable. Send needs
 * no plan: the app answers with what it did to each file.
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

type Busy = 'download' | 'plan' | 'install' | 'send' | 'check' | 'replace' | null

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
  // Empty until the effect below runs: the default is derived from
  // `window.location`, so rendering it on the server would hydrate wrong.
  const [appUrl, setAppUrl] = useState('')
  const [checked, setChecked] = useState<string | null>(null)
  const [send, setSend] = useState<OssmSendResult | null>(null)

  useEffect(() => {
    setAppUrl(resolveOssmAppUrl(getSettings().ossmAppUrl))
  }, [])

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
    setSend(null)
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

  /**
   * Persist the typed address, normalised, and answer with what the requests
   * will actually use. Stored per device rather than server-side: the phone's
   * answer and the desktop's answer are different, and one setting on the
   * server could only hold one of them.
   */
  function commitUrl(): string {
    const resolved = resolveOssmAppUrl(appUrl)
    setAppUrl(resolved)
    setSettings({ ossmAppUrl: appUrl.trim() ? resolved : '' })
    return resolved
  }

  async function onCheck() {
    setBusy('check')
    setError(null)
    setChecked(null)
    const res = await checkOssmApp(commitUrl())
    setBusy(null)
    if (res.ok) setChecked(`OSSM Sauce answered at ${res.url}.`)
    else setError(res.error)
  }

  async function onSend() {
    setBusy('send')
    setError(null)
    setChecked(null)
    setSend(null)
    const url = commitUrl()
    try {
      const payload = await fetchOssmPayload(request)
      // `replace` is left off: the app refuses with 409 if the queue is not
      // empty, and that refusal is the user's only chance to object.
      setSend(await sendOssmPayload(payload, url))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  /** Only after the user has been asked — a 409 means something may be playing. */
  async function onReplaceQueue() {
    if (!send) return
    setBusy('replace')
    setError(null)
    const playlist = await sendOssmPlaylist(send.url, send.playlistLines, true)
    setSend({ ...send, playlist })
    setBusy(null)
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
          className="device-btn"
          onClick={onPlan}
          disabled={disabled || plan !== null}
        >
          {busy === 'plan' ? 'Checking…' : 'Install to OSSM Sauce'}
        </button>
        <button
          type="button"
          className="device-btn device-btn-primary"
          onClick={() => void onSend()}
          disabled={disabled}
        >
          {busy === 'send' ? 'Sending…' : 'Send to the app'}
        </button>
      </div>

      {/* The app may or may not be on the machine serving this page, so the
          address is the user's to say — and it is per device. */}
      <div className="ossm-app-row">
        <span className="ossm-plan-label">OSSM Sauce app</span>
        <div className="ossm-app-field">
          <input
            className="ossm-app-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={`http://…:8081`}
            value={appUrl}
            onChange={(e) => setAppUrl(e.target.value)}
            onBlur={commitUrl}
          />
          <button
            type="button"
            className="device-btn"
            onClick={() => void onCheck()}
            disabled={busy !== null}
          >
            {busy === 'check' ? 'Testing…' : 'Test'}
          </button>
        </div>
      </div>

      {checked && <p className="ossm-note ossm-note-ok">{checked}</p>}
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

      {send && (
        <div
          className={`ossm-plan${send.files.every((f) => f.stored) && send.playlist.outcome !== 'failed' && send.playlist.outcome !== 'conflict' ? ' ossm-result' : ''}`}
        >
          <div className="ossm-plan-row">
            <span className="ossm-plan-label">Sent to</span>
            <span className="ossm-plan-path">{send.url}</span>
          </div>
          <div className="ossm-plan-summary">{summarizeSend(send)}</div>

          <ul className="ossm-file-list">
            {send.files.map((f) => {
              const renamed = !!f.stored && f.stored !== f.requested
              const status = !f.stored
                ? 'failed'
                : f.reused
                  ? 'identical'
                  : renamed
                    ? 'renamed'
                    : 'new'
              return (
                <li className="ossm-file" key={f.requested}>
                  <span className="ossm-file-name" title={f.error ?? f.requested}>
                    {f.stored ?? f.requested}
                  </span>
                  <span
                    className={`ossm-file-status ossm-file-status-${status}`}
                    title={
                      renamed
                        ? `A different file already held "${f.requested}", so the app stored this one as "${f.stored}". The playlist points at the new name.`
                        : f.reused
                          ? 'The app already had these exact bytes and kept the file it has.'
                          : (f.error ?? 'Stored in the app’s paths folder.')
                    }
                  >
                    {!f.stored
                      ? 'failed'
                      : f.reused
                        ? 'already there'
                        : renamed
                          ? 'renamed'
                          : 'sent'}
                  </span>
                </li>
              )
            })}
          </ul>

          {/* Per-file failures: which file, not just how many. */}
          {send.files
            .filter((f) => f.error)
            .map((f) => (
              <p className="ossm-note ossm-note-error" key={f.requested}>
                {f.error}
              </p>
            ))}

          {send.playlist.outcome === 'sent' && (
            <p className="ossm-note">
              Playlist loaded — {send.playlist.entries} entr
              {send.playlist.entries === 1 ? 'y' : 'ies'} in the queue
              {send.playlist.missing > 0
                ? `, ${send.playlist.missing} of which the app could not load (a path needs at least 6 markers).`
                : '.'}
            </p>
          )}

          {/* 409. Retrying with replace:true on its own would discard a queue
              that may be playing, so the app's objection is passed on as-is. */}
          {send.playlist.outcome === 'conflict' && (
            <>
              <p className="ossm-note ossm-note-warn">
                The paths are in the app, but its queue is not empty:{' '}
                {send.playlist.error} Replacing it discards whatever is queued now,
                which may be playing.
              </p>
              <div className="ossm-actions">
                <button
                  type="button"
                  className="device-btn device-btn-primary"
                  onClick={() => void onReplaceQueue()}
                  disabled={busy !== null}
                >
                  {busy === 'replace' ? 'Replacing…' : 'Replace the queue'}
                </button>
                <button
                  type="button"
                  className="device-btn"
                  onClick={() =>
                    setSend({
                      ...send,
                      // Clear the 409 text with it: the queue being left alone
                      // is now the chosen outcome, not a failure to report.
                      playlist: { ...send.playlist, outcome: 'skipped', error: null },
                    })
                  }
                  disabled={busy !== null}
                >
                  Leave it
                </button>
              </div>
            </>
          )}

          {send.playlist.outcome === 'failed' && (
            <p className="ossm-note ossm-note-error">
              The paths are in the app, but the playlist was not loaded:{' '}
              {send.playlist.error}
            </p>
          )}

          {send.playlist.outcome === 'skipped' && (
            <p className="ossm-note">
              {send.playlist.error ??
                'The queue was left as it was — the paths are in the app and can be added by hand.'}
            </p>
          )}

          {send.warnings.map((w, i) => (
            <p className="ossm-note ossm-note-warn" key={i}>
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
