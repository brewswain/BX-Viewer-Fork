/**
 * User settings, persisted in localStorage. The storage key and the defaults
 * are load-bearing: changing either silently resets every existing install's
 * preferences.
 */

export const BX_SETTINGS_KEY = 'bx_viewer_settings'

export type Settings = {
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
  /** Opt-out: videos open in theater mode unless this is explicitly false. */
  defaultTheater: boolean
  defaultZoom: number
  defaultPathSpeed: number
  effectsColorEnabled: boolean
  effectsTextEnabled: boolean
  effectsSpeedEnabled: boolean
  dhMode: boolean
  /**
   * Haptic device output. Kept flat and prefixed rather than nested, because
   * `getSettings` merges a stored blob over `DEFAULTS` one level deep — a
   * nested object would not pick up newly added keys for existing installs.
   */
  deviceEnabled: boolean
  deviceAutoConnect: boolean
  deviceBackend: 'buttplug' | 'xtoys' | 'ossm'
  deviceButtplugUrl: string
  deviceXToysUrl: string
  deviceOssmUrl: string
  deviceRangeMin: number
  deviceRangeMax: number
  deviceInvert: boolean
  deviceOffsetMs: number
  deviceMinCmdMs: number
}

export const DEFAULTS: Settings = {
  pathColor: '#f0b429',
  ballColor: '#ffffff',
  bgColor: '#0a0b0f',
  bgTransparent: true,
  topLineInactive: '#ffffff',
  topLineActive: '#3dd6c8',
  bottomLineInactive: '#ffffff',
  bottomLineActive: '#f07849',
  defaultOverlay: false,
  defaultOverlayBg: false,
  defaultFlipY: false,
  defaultTheater: true,
  defaultZoom: 0.25,
  defaultPathSpeed: 1.0,
  effectsColorEnabled: true,
  effectsTextEnabled: true,
  effectsSpeedEnabled: true,
  dhMode: false,
  // Off by default: a viewer that starts driving hardware because a page was
  // opened would be a genuinely bad surprise.
  deviceEnabled: false,
  deviceAutoConnect: false,
  // Default to the MCP route: it is the only one OSSM Sauce does not silently
  // rewrite, and the only one that needs no per-launch fiddling.
  deviceBackend: 'ossm',
  deviceButtplugUrl: 'ws://127.0.0.1:12345',
  deviceXToysUrl: 'ws://127.0.0.1:8080',
  deviceOssmUrl: 'http://127.0.0.1:8081',
  deviceRangeMin: 0,
  deviceRangeMax: 1,
  deviceInvert: false,
  deviceOffsetMs: 0,
  deviceMinCmdMs: 100,
}

export function getSettings(): Settings {
  if (typeof window === 'undefined') return { ...DEFAULTS }
  try {
    const raw = localStorage.getItem(BX_SETTINGS_KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function setSettings(partial: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...partial }
  localStorage.setItem(BX_SETTINGS_KEY, JSON.stringify(next))
  return next
}

export function resetSettings(): Settings {
  localStorage.removeItem(BX_SETTINGS_KEY)
  return { ...DEFAULTS }
}

/** The device-relevant subset, in the shape `deviceManager.configure` wants. */
export function deviceConfigFromSettings(s: Settings) {
  return {
    backend: s.deviceBackend,
    buttplugUrl: s.deviceButtplugUrl,
    xtoysUrl: s.deviceXToysUrl,
    ossmUrl: s.deviceOssmUrl,
    enabled: s.deviceEnabled,
    autoConnect: s.deviceAutoConnect,
    rangeMin: s.deviceRangeMin,
    rangeMax: s.deviceRangeMax,
    invert: s.deviceInvert,
    offsetMs: s.deviceOffsetMs,
    minCmdMs: s.deviceMinCmdMs,
  }
}
