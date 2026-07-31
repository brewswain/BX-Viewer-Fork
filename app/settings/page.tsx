'use client'

import { useEffect, useState } from 'react'
import SiteHeader from '@/components/SiteHeader'
import {
  DEFAULTS,
  getSettings,
  resetSettings,
  setSettings,
  type Settings,
} from '@/lib/settings'

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
  /** Kept as strings — these mirror the raw <input> values, as the DOM did. */
  defaultZoom: string
  defaultPathSpeed: string
  effectsColorEnabled: boolean
  effectsTextEnabled: boolean
  effectsSpeedEnabled: boolean
  dhMode: boolean
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
    defaultZoom: String(s.defaultZoom),
    defaultPathSpeed: String(s.defaultPathSpeed),
    effectsColorEnabled: s.effectsColorEnabled !== false,
    effectsTextEnabled: s.effectsTextEnabled !== false,
    effectsSpeedEnabled: s.effectsSpeedEnabled !== false,
    dhMode: s.dhMode === true,
  }
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
      defaultZoom: parseFloat(form.defaultZoom),
      defaultPathSpeed: parseFloat(form.defaultPathSpeed),
      effectsColorEnabled: form.effectsColorEnabled,
      effectsTextEnabled: form.effectsTextEnabled,
      effectsSpeedEnabled: form.effectsSpeedEnabled,
      dhMode: form.dhMode,
    })
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
                These apply each time you open a new video or playlist.
              </p>
              <div className="settings-checkboxes">
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
