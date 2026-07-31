/**
 * Formatting, escaping, fetch and colour helpers — ported verbatim from
 * app/player-core.js.
 *
 * `escHtml` / `renderDescription` still return HTML *strings*: descriptions may
 * contain `[label](url)` links and `\n` breaks, so the pages feed the result to
 * `dangerouslySetInnerHTML` exactly as the legacy code fed it to `innerHTML`.
 */

import type { Settings } from '@/lib/settings'
import { FPS } from './constants'
import type { BxEffect, Rgb } from './types'

// ── Easing Labels ────────────────────────────────────────────────────────────

const TRANS_NAMES = [
  'Lin',
  'Sine',
  'Quint',
  'Quart',
  'Quad',
  'Expo',
  'Elastic',
  'Cubic',
  'Circ',
  'Bounce',
  'Back',
  'Spring',
]
const EASE_NAMES = ['In', 'Out', 'IO', 'OI']

export function easeLabel(trans: number, ease: number): string {
  return `${TRANS_NAMES[trans] || '?'}·${EASE_NAMES[ease] || '?'}`
}

// ── Utilities ────────────────────────────────────────────────────────────────

export function framesToTimecode(frames: number): string {
  const secs = Math.floor(frames / FPS)
  return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`
}

export function escHtml(s: unknown): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderDescription(text: unknown): string {
  return escHtml(text)
    .replace(/\\n/g, '<br>')
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m: string, label: string, url: string) =>
        `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:none;">${label}</a>`,
    )
}

export async function fetchJSON<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  try {
    return (await res.json()) as T
  } catch (e) {
    throw new Error(`JSON parse failed for: ${url} (${(e as Error).message})`)
  }
}

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return res.text()
}

export function hexToRgba(hex: unknown, alpha?: number | null): string | null {
  if (!hex || typeof hex !== 'string' || !hex.startsWith('#')) return null
  const n = parseInt(hex.slice(1), 16)
  if (Number.isNaN(n)) return null
  const r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255
  return alpha != null ? `rgba(${r},${g},${b},${alpha})` : `rgb(${r},${g},${b})`
}

export type PlayerColors = {
  bgSolid: string
  bgOverlay: string
  topLine: string
  bottomLine: string
  topActive: string
  bottomActive: string
  ball: string
  pathColor: string
}

export function buildColors(userSettings: Partial<Settings>): PlayerColors {
  const def = (v: string | undefined, d: string) =>
    v != null && v !== '' ? v : d
  return {
    bgSolid:
      (userSettings.bgColor && hexToRgba(userSettings.bgColor, 0.92)) ||
      '#0a0b0f',
    bgOverlay:
      (userSettings.bgColor && hexToRgba(userSettings.bgColor, 0.45)) ||
      'rgba(0,0,0,0.45)',
    topLine:
      (userSettings.topLineInactive &&
        hexToRgba(userSettings.topLineInactive, 0.15)) ||
      'rgba(255,255,255,0.15)',
    bottomLine:
      (userSettings.bottomLineInactive &&
        hexToRgba(userSettings.bottomLineInactive, 0.15)) ||
      'rgba(255,255,255,0.15)',
    topActive: def(userSettings.topLineActive, '#3dd6c8'),
    bottomActive: def(userSettings.bottomLineActive, '#f07849'),
    ball: def(userSettings.ballColor, '#ffffff'),
    pathColor: def(userSettings.pathColor, '#f0b429'),
  }
}

// ── BX2 Effect Helpers ────────────────────────────────────────────────────────

export function getEffectFadeAlpha(ef: BxEffect, frame: number): number {
  if (frame < ef.startFrame || frame > ef.endFrame) return 0
  const dur = ef.endFrame - ef.startFrame
  const el = frame - ef.startFrame
  let alpha = 1.0
  const fi = ef.fadeIn ?? 0
  const fo = ef.fadeOut ?? 0
  if (fi > 0 && el < fi) alpha = Math.min(alpha, el / fi)
  if (fo > 0 && el > dur - fo) alpha = Math.min(alpha, (dur - el) / fo)
  return Math.max(0, Math.min(1, alpha))
}

export function hexToRgbArr(hex: unknown): Rgb {
  const h = String(hex || '#888888')
    .replace('#', '')
    .padEnd(6, '0')
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function lerpRgbArr(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

export function getEffectiveColorRgb(
  effects: BxEffect[],
  frame: number,
  basePathHex: string,
  baseBallHex: string,
  settings: Partial<Settings> | null | undefined,
  baseBgHex?: string,
): { pathRgb: Rgb; ballRgb: Rgb; bgRgb: Rgb | null } {
  let pathRgb = hexToRgbArr(basePathHex)
  let ballRgb = hexToRgbArr(baseBallHex)
  let bgRgb: Rgb | null = null
  if (settings && settings.effectsColorEnabled === false)
    return { pathRgb, ballRgb, bgRgb }
  for (const ef of effects) {
    if (ef.type !== 'pathColor') continue
    const alpha = getEffectFadeAlpha(ef, frame)
    if (alpha <= 0) continue
    if (ef.pathColor)
      pathRgb = lerpRgbArr(pathRgb, hexToRgbArr(ef.pathColor), alpha)
    if (ef.ballColor)
      ballRgb = lerpRgbArr(ballRgb, hexToRgbArr(ef.ballColor), alpha)
    if (ef.bgColor) {
      const base = bgRgb || hexToRgbArr(baseBgHex || '#0a0b0f')
      bgRgb = lerpRgbArr(base, hexToRgbArr(ef.bgColor), alpha)
    }
  }
  return { pathRgb, ballRgb, bgRgb }
}
