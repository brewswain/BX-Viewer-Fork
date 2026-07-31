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
  defaultZoom: number
  defaultPathSpeed: number
  effectsColorEnabled: boolean
  effectsTextEnabled: boolean
  effectsSpeedEnabled: boolean
  dhMode: boolean
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
  defaultZoom: 0.25,
  defaultPathSpeed: 1.0,
  effectsColorEnabled: true,
  effectsTextEnabled: true,
  effectsSpeedEnabled: true,
  dhMode: false,
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
