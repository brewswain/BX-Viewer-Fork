'use client'

import { useState } from 'react'
import Link from 'next/link'
import { deviceManager } from '@/lib/device/manager'
import { useDeviceState } from '@/lib/device/useDevice'

/**
 * Connection status and manual connect/disconnect for the player sidebar.
 *
 * Configuration deliberately lives on the settings page — this panel is for the
 * things you need *while* a video is open: is it connected, is it actually
 * driving, and what went wrong if not.
 */

const STATE_LABEL: Record<string, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Error',
}

export default function DevicePanel() {
  const state = useDeviceState()
  const [busy, setBusy] = useState(false)
  const [showLog, setShowLog] = useState(false)

  const { connection, config, devices, armed, planCommands, detail } = state
  const connected = connection === 'connected'
  const target = devices.find((d) => d.linear) ?? devices[0]

  async function toggleConnection() {
    setBusy(true)
    try {
      if (connected || connection === 'connecting') deviceManager.disconnect()
      else await deviceManager.connect()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sidebar-section device-panel">
      <div className="sidebar-title device-panel-title">
        <span>Device</span>
        <span
          className={`device-dot device-dot-${armed ? 'armed' : connection}`}
          aria-hidden="true"
        />
      </div>

      <div className="device-status-row">
        <span className="device-status-label">
          {armed ? 'Driving' : STATE_LABEL[connection] ?? connection}
        </span>
        <span className="device-status-target">
          {connected ? (target?.name ?? 'No device') : config.backend}
        </span>
      </div>

      {detail && connection === 'error' && (
        <p className="device-detail device-detail-error">{detail}</p>
      )}

      {connected && devices.length === 0 && (
        <p className="device-detail">
          Server connected, but no devices are present. Turn the toy on and
          scan.
        </p>
      )}

      {connected && devices.length > 0 && !target?.linear && (
        <p className="device-detail">
          No connected device supports positional control, so there is nothing
          to drive from the path.
        </p>
      )}

      {connected && !config.enabled && (
        <p className="device-detail">
          Output is switched off in <Link href="/settings">settings</Link>.
        </p>
      )}

      {connected && config.enabled && planCommands === 0 && (
        <p className="device-detail">
          No stroke plan — this .bx has too few markers to drive a device.
        </p>
      )}

      <div className="device-actions">
        <button
          type="button"
          className="device-btn device-btn-primary"
          onClick={toggleConnection}
          disabled={busy}
        >
          {connected || connection === 'connecting' ? 'Disconnect' : 'Connect'}
        </button>
        {connected && config.backend === 'buttplug' && (
          <button
            type="button"
            className="device-btn"
            onClick={() => deviceManager.scan()}
          >
            Scan
          </button>
        )}
        <Link className="device-btn" href="/settings">
          Settings
        </Link>
      </div>

      {planCommands > 0 && (
        <div className="device-meta">{planCommands.toLocaleString()} moves planned</div>
      )}

      <button
        type="button"
        className="device-log-toggle"
        onClick={() => setShowLog((v) => !v)}
      >
        {showLog ? 'Hide' : 'Show'} log ({state.log.length})
      </button>
      {showLog && (
        <div className="device-log">
          {state.log.length === 0 ? (
            <div className="device-log-line">Nothing logged yet.</div>
          ) : (
            state.log
              .slice()
              .reverse()
              .map((line, i) => (
                <div className="device-log-line" key={`${i}-${line}`}>
                  {line}
                </div>
              ))
          )}
        </div>
      )}
    </div>
  )
}
