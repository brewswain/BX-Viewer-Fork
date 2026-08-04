'use client'

import { useEffect, useState } from 'react'
import SiteHeader from '@/components/SiteHeader'
import { deviceManager } from '@/lib/device/manager'
import {
  DEFAULTS,
  deviceConfigFromSettings,
  getSettings,
  resetSettings,
  setSettings,
  type Settings,
} from '@/lib/settings'

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

type FormState = {
  pathColor: string
  ballColor: string
  bgColor: string
  bgTransparent: boolean
  topLineInactive: string
  topLineActive: string
  bottomLineInactive: string
  bottomLineActive: string
  defaultOverlay: boolean
  defaultOverlayBg: boolean
  defaultFlipY: boolean
  defaultTheater: boolean
  /** Kept as strings — these mirror the raw <input> values, as the DOM did. */
  defaultZoom: string
  defaultPathSpeed: string
  effectsColorEnabled: boolean
  effectsTextEnabled: boolean
  effectsSpeedEnabled: boolean
  dhMode: boolean
  deviceEnabled: boolean
  deviceAutoConnect: boolean
  deviceBackend: 'buttplug' | 'xtoys' | 'ossm'
  deviceButtplugUrl: string
  deviceXToysUrl: string
  deviceOssmUrl: string
  deviceInvert: boolean
  /** Numeric fields stay strings, mirroring the raw <input> values. */
  deviceRangeMin: string
  deviceRangeMax: string
  deviceOffsetMs: string
  deviceMinCmdMs: string
}

function rgbaToHex(rgba: string): string | null {
  if (!rgba || rgba.startsWith('#')) return rgba
  const m = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!m) return null
  const r = parseInt(m[1], 10).toString(16).padStart(2, '0')
  const g = parseInt(m[2], 10).toString(16).padStart(2, '0')
  const b = parseInt(m[3], 10).toString(16).padStart(2, '0')
  return '#' + r + g + b
}

function toForm(s: Settings): FormState {
  return {
    pathColor: s.pathColor,
    ballColor: s.ballColor,
    bgColor: s.bgColor || '#0a0b0f',
    bgTransparent: s.bgTransparent !== false,
    topLineInactive: rgbaToHex(s.topLineInactive) || s.topLineInactive || '#ffffff',
    topLineActive: s.topLineActive,
    bottomLineInactive:
      rgbaToHex(s.bottomLineInactive) || s.bottomLineInactive || '#ffffff',
    bottomLineActive: s.bottomLineActive,
    defaultOverlay: s.defaultOverlay,
    defaultOverlayBg: s.defaultOverlayBg,
    defaultFlipY: s.defaultFlipY,
    defaultTheater: s.defaultTheater !== false,
    defaultZoom: String(s.defaultZoom),
    defaultPathSpeed: String(s.defaultPathSpeed),
    effectsColorEnabled: s.effectsColorEnabled !== false,
    effectsTextEnabled: s.effectsTextEnabled !== false,
    effectsSpeedEnabled: s.effectsSpeedEnabled !== false,
    dhMode: s.dhMode === true,
    deviceEnabled: s.deviceEnabled === true,
    deviceAutoConnect: s.deviceAutoConnect === true,
    deviceBackend:
      s.deviceBackend === 'xtoys'
        ? 'xtoys'
        : s.deviceBackend === 'buttplug'
          ? 'buttplug'
          : 'ossm',
    deviceButtplugUrl: s.deviceButtplugUrl,
    deviceXToysUrl: s.deviceXToysUrl,
    deviceOssmUrl: s.deviceOssmUrl,
    deviceInvert: s.deviceInvert === true,
    deviceRangeMin: String(Math.round(s.deviceRangeMin * 100)),
    deviceRangeMax: String(Math.round(s.deviceRangeMax * 100)),
    deviceOffsetMs: String(s.deviceOffsetMs),
    deviceMinCmdMs: String(s.deviceMinCmdMs),
  }
}

/** Parse a form number, falling back to the default when left blank or junk. */
function num(value: string, fallback: number): number {
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : fallback
}

export default function SettingsPage() {
  // Seeded from DEFAULTS so the server render matches; the stored settings are
  // pulled in on mount (localStorage is client-only).
  const [form, setForm] = useState<FormState>(() => toForm(DEFAULTS))
  /** `n` doubles as the remount key so the flash animation restarts. */
  const [msg, setMsg] = useState<{ text: string; n: number }>({ text: '', n: 0 })

  function loadSettings() {
    setForm(toForm(getSettings()))
  }

  useEffect(() => {
    loadSettings()
  }, [])

  function flashMsg(text: string) {
    setMsg((m) => ({ text, n: m.n + 1 }))
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSettings({
      pathColor: form.pathColor,
      ballColor: form.ballColor,
      bgColor: form.bgColor,
      bgTransparent: form.bgTransparent,
      topLineInactive: form.topLineInactive,
      topLineActive: form.topLineActive,
      bottomLineInactive: form.bottomLineInactive,
      bottomLineActive: form.bottomLineActive,
      defaultOverlay: form.defaultOverlay,
      defaultOverlayBg: form.defaultOverlayBg,
      defaultFlipY: form.defaultFlipY,
      defaultTheater: form.defaultTheater,
      defaultZoom: parseFloat(form.defaultZoom),
      defaultPathSpeed: parseFloat(form.defaultPathSpeed),
      effectsColorEnabled: form.effectsColorEnabled,
      effectsTextEnabled: form.effectsTextEnabled,
      effectsSpeedEnabled: form.effectsSpeedEnabled,
      dhMode: form.dhMode,
      deviceEnabled: form.deviceEnabled,
      deviceAutoConnect: form.deviceAutoConnect,
      deviceBackend: form.deviceBackend,
      deviceButtplugUrl: form.deviceButtplugUrl.trim() || DEFAULTS.deviceButtplugUrl,
      deviceXToysUrl: form.deviceXToysUrl.trim() || DEFAULTS.deviceXToysUrl,
      deviceOssmUrl: form.deviceOssmUrl.trim() || DEFAULTS.deviceOssmUrl,
      deviceInvert: form.deviceInvert,
      // Stored 0..1; the UI works in percent because that is how stroke range
      // is labelled on every device that has the setting.
      deviceRangeMin: clamp01(num(form.deviceRangeMin, 0) / 100),
      deviceRangeMax: clamp01(num(form.deviceRangeMax, 100) / 100),
      deviceOffsetMs: num(form.deviceOffsetMs, 0),
      deviceMinCmdMs: Math.max(20, num(form.deviceMinCmdMs, DEFAULTS.deviceMinCmdMs)),
    })
    // The manager is live across pages, so a save has to reach it immediately —
    // otherwise the change would not apply until the next video load.
    deviceManager.configure(deviceConfigFromSettings(getSettings()))
    flashMsg('Saved!')
  }

  function handleReset() {
    if (!confirm('Reset all settings to defaults?')) return
    resetSettings()
    loadSettings()
    flashMsg('Reset to defaults!')
  }

  function setAllEffects(value: boolean) {
    setForm((f) => ({
      ...f,
      effectsColorEnabled: value,
      effectsTextEnabled: value,
      effectsSpeedEnabled: value,
    }))
  }

  return (
    <>
      <SiteHeader active="settings" />

      <main className="main-content">
        <div className="settings-layout">
          <div className="settings-hero">
            <h1 className="settings-title">User Settings</h1>
            <p className="settings-tagline">
              Customize colors and defaults. Stored in this browser only.
            </p>
          </div>

          <form id="settingsForm" className="settings-form" onSubmit={handleSubmit}>
            <section className="settings-section">
              <h2 className="settings-section-title">Waveform &amp; ball</h2>
              <div className="settings-grid">
                <label className="settings-row">
                  <span className="settings-label">Path color</span>
                  <input
                    type="color"
                    id="pathColor"
                    name="pathColor"
                    className="settings-color"
                    value={form.pathColor}
                    onChange={(e) => set('pathColor', e.target.value)}
                  />
                </label>
                <label className="settings-row">
                  <span className="settings-label">Ball color</span>
                  <input
                    type="color"
                    id="ballColor"
                    name="ballColor"
                    className="settings-color"
                    value={form.ballColor}
                    onChange={(e) => set('ballColor', e.target.value)}
                  />
                </label>
                <label className="settings-row">
                  <span className="settings-label">Background color</span>
                  <input
                    type="color"
                    id="bgColor"
                    name="bgColor"
                    className="settings-color"
                    value={form.bgColor}
                    onChange={(e) => set('bgColor', e.target.value)}
                  />
                </label>
                <label className="settings-check" style={{ gridColumn: '1/-1' }}>
                  <input
                    type="checkbox"
                    id="bgTransparent"
                    name="bgTransparent"
                    checked={form.bgTransparent}
                    onChange={(e) => set('bgTransparent', e.target.checked)}
                  />
                  <span>Semi-transparent background (like overlay)</span>
                </label>
              </div>
            </section>

            <section className="settings-section">
              <h2 className="settings-section-title">Top border</h2>
              <div className="settings-grid">
                <label className="settings-row">
                  <span className="settings-label">Inactive</span>
                  <input
                    type="color"
                    id="topLineInactive"
                    name="topLineInactive"
                    className="settings-color"
                    value={form.topLineInactive}
                    onChange={(e) => set('topLineInactive', e.target.value)}
                  />
                </label>
                <label className="settings-row">
                  <span className="settings-label">Active (ball near top)</span>
                  <input
                    type="color"
                    id="topLineActive"
                    name="topLineActive"
                    className="settings-color"
                    value={form.topLineActive}
                    onChange={(e) => set('topLineActive', e.target.value)}
                  />
                </label>
              </div>
            </section>

            <section className="settings-section">
              <h2 className="settings-section-title">Bottom border</h2>
              <div className="settings-grid">
                <label className="settings-row">
                  <span className="settings-label">Inactive</span>
                  <input
                    type="color"
                    id="bottomLineInactive"
                    name="bottomLineInactive"
                    className="settings-color"
                    value={form.bottomLineInactive}
                    onChange={(e) => set('bottomLineInactive', e.target.value)}
                  />
                </label>
                <label className="settings-row">
                  <span className="settings-label">Active (ball near bottom)</span>
                  <input
                    type="color"
                    id="bottomLineActive"
                    name="bottomLineActive"
                    className="settings-color"
                    value={form.bottomLineActive}
                    onChange={(e) => set('bottomLineActive', e.target.value)}
                  />
                </label>
              </div>
            </section>

            <section className="settings-section">
              <h2 className="settings-section-title">
                Defaults when opening a video
              </h2>
              <p className="settings-hint">
                Saved in this browser and applied each time you open a new video
                or playlist.
              </p>
              <div className="settings-checkboxes">
                <label className="settings-check">
                  <input
                    type="checkbox"
                    id="defaultTheater"
                    name="defaultTheater"
                    checked={form.defaultTheater}
                    onChange={(e) => set('defaultTheater', e.target.checked)}
                  />
                  <span>
                    Theater mode on <span className="settings-hint">(T or Esc leaves it)</span>
                  </span>
                </label>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    id="defaultOverlay"
                    name="defaultOverlay"
                    checked={form.defaultOverlay}
                    onChange={(e) => set('defaultOverlay', e.target.checked)}
                  />
                  <span>Overlay mode on</span>
                </label>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    id="defaultOverlayBg"
                    name="defaultOverlayBg"
                    checked={form.defaultOverlayBg}
                    onChange={(e) => set('defaultOverlayBg', e.target.checked)}
                  />
                  <span>Overlay background on</span>
                </label>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    id="defaultFlipY"
                    name="defaultFlipY"
                    checked={form.defaultFlipY}
                    onChange={(e) => set('defaultFlipY', e.target.checked)}
                  />
                  <span>Flip Y on</span>
                </label>
              </div>
              <label className="settings-row settings-row-slider">
                <span className="settings-label">Default zoom</span>
                <input
                  type="range"
                  id="defaultZoom"
                  name="defaultZoom"
                  className="settings-zoom-slider"
                  min="0.05"
                  max="0.5"
                  step="0.05"
                  value={form.defaultZoom}
                  onChange={(e) => set('defaultZoom', e.target.value)}
                />
                <span className="settings-zoom-value" id="defaultZoomValue">
                  {form.defaultZoom}
                </span>
              </label>
              <label className="settings-row settings-row-slider">
                <span className="settings-label">Default path speed</span>
                <input
                  type="range"
                  id="defaultPathSpeed"
                  name="defaultPathSpeed"
                  className="settings-zoom-slider"
                  min="0.5"
                  max="4.0"
                  step="0.25"
                  value={form.defaultPathSpeed}
                  onChange={(e) => set('defaultPathSpeed', e.target.value)}
                />
                <span className="settings-zoom-value" id="defaultPathSpeedValue">
                  {form.defaultPathSpeed}×
                </span>
              </label>
            </section>

            <section className="settings-section">
              <h2 className="settings-section-title">Effects</h2>
              <p
                style={{
                  fontSize: '0.82rem',
                  opacity: 0.55,
                  marginBottom: '0.75rem',
                }}
              >
                These effects are embedded in .bx path files by the BounceX Editor.
                Disable any you don&apos;t want shown.
              </p>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '0.6rem' }}>
                <button
                  type="button"
                  className="settings-btn settings-btn-secondary"
                  id="effectsEnableAll"
                  style={{ fontSize: '0.78rem', padding: '3px 10px' }}
                  onClick={() => setAllEffects(true)}
                >
                  Enable all
                </button>
                <button
                  type="button"
                  className="settings-btn settings-btn-secondary"
                  id="effectsDisableAll"
                  style={{ fontSize: '0.78rem', padding: '3px 10px' }}
                  onClick={() => setAllEffects(false)}
                >
                  Disable all
                </button>
              </div>
              <label className="settings-row">
                <input
                  type="checkbox"
                  id="effectsColorEnabled"
                  name="effectsColorEnabled"
                  checked={form.effectsColorEnabled}
                  onChange={(e) => set('effectsColorEnabled', e.target.checked)}
                />
                <span className="settings-label">Path color effects</span>
                <span className="settings-hint">
                  Smooth colour transitions on the path &amp; ball
                </span>
              </label>
              <label className="settings-row">
                <input
                  type="checkbox"
                  id="effectsTextEnabled"
                  name="effectsTextEnabled"
                  checked={form.effectsTextEnabled}
                  onChange={(e) => set('effectsTextEnabled', e.target.checked)}
                />
                <span className="settings-label">Text overlays</span>
                <span className="settings-hint">
                  Text displayed over the path preview
                </span>
              </label>
              <label className="settings-row">
                <input
                  type="checkbox"
                  id="effectsSpeedEnabled"
                  name="effectsSpeedEnabled"
                  checked={form.effectsSpeedEnabled}
                  onChange={(e) => set('effectsSpeedEnabled', e.target.checked)}
                />
                <span className="settings-label">Path speed changes</span>
                <span className="settings-hint">
                  Dynamic waveform speed transitions
                </span>
              </label>
            </section>

            <section className="settings-section">
              <h2 className="settings-section-title">DH Mode</h2>
              <p
                style={{
                  fontSize: '0.82rem',
                  opacity: 0.55,
                  marginBottom: '0.75rem',
                }}
              >
                Replaces the waveform with scrolling circles that hit the center line
                on each peak marker. All other settings (zoom, speed, overlay, etc.)
                still apply.
              </p>
              <label className="settings-check">
                <input
                  type="checkbox"
                  id="dhMode"
                  name="dhMode"
                  checked={form.dhMode}
                  onChange={(e) => set('dhMode', e.target.checked)}
                />
                <span>Enable DH Mode</span>
              </label>
            </section>

            <section className="settings-section">
              <h2 className="settings-section-title">Device output (OSSM)</h2>
              <p
                style={{
                  fontSize: '0.82rem',
                  opacity: 0.55,
                  marginBottom: '0.75rem',
                }}
              >
                Drives a stroker from the same .bx path the waveform is drawn
                from, in sync with the video. The path is converted to plain
                move-to-position commands in the browser, so the easing you see
                is the easing the machine gets. Connect from the Device panel in
                the player&apos;s <em>BounceX Data</em> sidebar tab.
              </p>

              <div className="settings-checkboxes">
                <label className="settings-check">
                  <input
                    type="checkbox"
                    id="deviceEnabled"
                    name="deviceEnabled"
                    checked={form.deviceEnabled}
                    onChange={(e) => set('deviceEnabled', e.target.checked)}
                  />
                  <span>Enable device output</span>
                </label>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    id="deviceAutoConnect"
                    name="deviceAutoConnect"
                    checked={form.deviceAutoConnect}
                    onChange={(e) => set('deviceAutoConnect', e.target.checked)}
                  />
                  <span>Connect automatically when a video opens</span>
                </label>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    id="deviceInvert"
                    name="deviceInvert"
                    checked={form.deviceInvert}
                    onChange={(e) => set('deviceInvert', e.target.checked)}
                  />
                  <span>Invert direction (swap top and bottom of the stroke)</span>
                </label>
              </div>

              <label className="settings-row">
                <span className="settings-label">Connection</span>
                <select
                  className="settings-select"
                  id="deviceBackend"
                  name="deviceBackend"
                  value={form.deviceBackend}
                  onChange={(e) =>
                    set(
                      'deviceBackend',
                      e.target.value as 'buttplug' | 'xtoys' | 'ossm',
                    )
                  }
                >
                  <option value="ossm">OSSM, raw (MCP bridge) — recommended</option>
                  <option value="xtoys">OSSM Sauce (XToys bridge)</option>
                  <option value="buttplug">Intiface Central (Buttplug)</option>
                </select>
              </label>

              {form.deviceBackend === 'ossm' ? (
                <>
                  <label className="settings-row">
                    <span className="settings-label">OSSM Sauce (MCP)</span>
                    <input
                      type="text"
                      className="settings-text"
                      id="deviceOssmUrl"
                      name="deviceOssmUrl"
                      value={form.deviceOssmUrl}
                      onChange={(e) => set('deviceOssmUrl', e.target.value)}
                    />
                  </label>
                  <div className="settings-device-note">
                    Sends the machine&apos;s own move command straight through
                    OSSM Sauce, untouched.
                    <ol>
                      <li>
                        OSSM Sauce → Bridge Settings → Bridge Mode:{' '}
                        <code>MCP</code>, then Enable.
                      </li>
                    </ol>
                    That is the entire setup. The other two routes hand OSSM
                    Sauce a <em>description</em> of each move and let its bridges
                    rewrite it — clamping anything shorter than{' '}
                    <code>Minimum Duration</code> and re-easing every stroke with{' '}
                    <code>Stroke Smoothing</code>, which resets to Sine on every
                    launch. Neither applies here, so there is nothing to set by
                    hand each session. This route is also the only one that can
                    tell you whether the OSSM itself is actually attached.
                  </div>
                </>
              ) : form.deviceBackend === 'buttplug' ? (
                <>
                  <label className="settings-row">
                    <span className="settings-label">Intiface server</span>
                    <input
                      type="text"
                      className="settings-text"
                      id="deviceButtplugUrl"
                      name="deviceButtplugUrl"
                      value={form.deviceButtplugUrl}
                      onChange={(e) => set('deviceButtplugUrl', e.target.value)}
                    />
                  </label>
                  <div className="settings-device-note">
                    To reach an OSSM through Intiface, OSSM Sauce registers
                    itself as a TCode device:
                    <ol>
                      <li>
                        Intiface Central → App Modes → Show Advanced Settings →
                        enable <code>Device Websocket Server</code>.
                      </li>
                      <li>
                        Devices → Websocket Devices → Add, with protocol{' '}
                        <code>tcode-v03</code> and name <code>ossm</code>.
                      </li>
                      <li>Start Intiface&apos;s server, then enable the Buttplug.io bridge in OSSM Sauce.</li>
                      <li>
                        In OSSM Sauce, set Bridge Settings → Speed Overrides →
                        Minimum Duration to about <code>50ms</code>. It defaults
                        to 500&nbsp;ms, which stretches every short stroke and
                        leaves the machine behind the video.
                      </li>
                      <li>
                        Set <code>Stroke Smoothing</code> on the bridge screen to{' '}
                        <code>Linear</code>. It defaults to Sine and re-eases
                        every move, so a curve we already flattened gets a stop
                        and restart at each step. OSSM Sauce does not remember
                        this one — set it every launch.
                      </li>
                    </ol>
                    Any other Buttplug device with positional control works too,
                    with no extra setup.
                  </div>
                </>
              ) : (
                <>
                  <label className="settings-row">
                    <span className="settings-label">OSSM Sauce (XToys)</span>
                    <input
                      type="text"
                      className="settings-text"
                      id="deviceXToysUrl"
                      name="deviceXToysUrl"
                      value={form.deviceXToysUrl}
                      onChange={(e) => set('deviceXToysUrl', e.target.value)}
                    />
                  </label>
                  <div className="settings-device-note">
                    Talks to OSSM Sauce directly, skipping Intiface. In OSSM
                    Sauce:
                    <ol>
                      <li>Bridge Settings → Bridge Mode: <code>XToys</code>, then Enable.</li>
                      <li>
                        Tick <code>Get stroke duration from command</code>, or
                        every stroke is forced to 1000 / Max Message Frequency
                        and our timing is ignored.
                      </li>
                      <li>
                        Set Speed Overrides → Minimum Duration to about{' '}
                        <code>50ms</code> (default 500&nbsp;ms is too slow for
                        dense paths).
                      </li>
                      <li>
                        Set <code>Stroke Smoothing</code> on the bridge screen to{' '}
                        <code>Linear</code>. It defaults to Sine and re-eases
                        every move, so a curve we already flattened gets a stop
                        and restart at each step. OSSM Sauce does not remember
                        this one — set it every launch.
                      </li>
                    </ol>
                    This bridge never reports back, so the viewer cannot tell
                    whether the OSSM itself is actually connected.
                  </div>
                </>
              )}

              <label className="settings-row">
                <span className="settings-label">Stroke range (%)</span>
                <input
                  type="number"
                  className="settings-number"
                  id="deviceRangeMin"
                  name="deviceRangeMin"
                  min="0"
                  max="100"
                  step="1"
                  value={form.deviceRangeMin}
                  onChange={(e) => set('deviceRangeMin', e.target.value)}
                />
                <input
                  type="number"
                  className="settings-number"
                  id="deviceRangeMax"
                  name="deviceRangeMax"
                  min="0"
                  max="100"
                  step="1"
                  value={form.deviceRangeMax}
                  onChange={(e) => set('deviceRangeMax', e.target.value)}
                />
                <span className="settings-hint">
                  Limits how much of the machine&apos;s travel the path uses
                </span>
              </label>

              <label className="settings-row">
                <span className="settings-label">Sync offset (ms)</span>
                <input
                  type="number"
                  className="settings-number"
                  id="deviceOffsetMs"
                  name="deviceOffsetMs"
                  step="10"
                  value={form.deviceOffsetMs}
                  onChange={(e) => set('deviceOffsetMs', e.target.value)}
                />
                <span className="settings-hint">
                  Positive delays the device; negative makes it lead the picture
                </span>
              </label>

              <label className="settings-row">
                <span className="settings-label">Minimum move (ms)</span>
                <input
                  type="number"
                  className="settings-number"
                  id="deviceMinCmdMs"
                  name="deviceMinCmdMs"
                  min="20"
                  step="10"
                  value={form.deviceMinCmdMs}
                  onChange={(e) => set('deviceMinCmdMs', e.target.value)}
                />
                <span className="settings-hint">
                  Commands closer together than this are merged. Raise it if the
                  device stutters or falls behind on dense paths.
                </span>
              </label>
            </section>

            <div className="settings-actions">
              <button type="submit" className="settings-btn settings-btn-primary">
                Save
              </button>
              <button
                type="button"
                id="resetBtn"
                className="settings-btn settings-btn-secondary"
                onClick={handleReset}
              >
                Reset to defaults
              </button>
              <span
                key={msg.n}
                className={`settings-saved-msg${msg.n > 0 ? ' visible' : ''}`}
                id="savedMsg"
              >
                {msg.text}
              </span>
            </div>
          </form>
        </div>
      </main>
    </>
  )
}
