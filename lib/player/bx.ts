/**
 * `.bx` parsing and path construction — easing, path building, effect-font
 * loading, and the marker/peak helpers shared by the watch and playlist pages.
 */

import { VIDEO_BASE } from './constants'
import type { BxEffect, Marker, MarkerData, RawBx } from './types'

// ── Godot 4 Tween Easing ─────────────────────────────────────────────────────
// TransitionType: 0=Linear 1=Sine 2=Quint 3=Quart 4=Quad 5=Expo
//                 6=Elastic 7=Cubic 8=Circ 9=Bounce 10=Back 11=Spring
// EaseType:       0=In 1=Out 2=InOut 3=OutIn

export function godotEase(t: number, trans: number, ease: number): number {
  const applyTrans = (x: number, type: number): number => {
    switch (type) {
      case 0:
        return x
      case 1:
        return 1 - Math.cos((x * Math.PI) / 2)
      case 2:
        return x * x * x * x * x
      case 3:
        return x * x * x * x
      case 4:
        return x * x
      case 5:
        return x === 0 ? 0 : Math.pow(2, 10 * x - 10)
      case 6: {
        if (x === 0) return 0
        if (x === 1) return 1
        return (
          -Math.pow(2, 10 * x - 10) *
          Math.sin(((x * 10 - 10.75) * (2 * Math.PI)) / 3)
        )
      }
      case 7:
        return x * x * x
      case 8:
        return 1 - Math.sqrt(1 - x * x)
      case 9: {
        const n1 = 7.5625,
          d1 = 2.75
        let xi = 1 - x
        if (xi < 1 / d1) return 1 - n1 * xi * xi
        else if (xi < 2 / d1) return 1 - (n1 * (xi -= 1.5 / d1) * xi + 0.75)
        else if (xi < 2.5 / d1)
          return 1 - (n1 * (xi -= 2.25 / d1) * xi + 0.9375)
        else return 1 - (n1 * (xi -= 2.625 / d1) * xi + 0.984375)
      }
      case 10: {
        const c1 = 1.70158,
          c3 = c1 + 1
        return c3 * x * x * x - c1 * x * x
      }
      case 11:
        return 1 - Math.cos(x * Math.PI) * Math.exp(-x * 5)
      default:
        return x
    }
  }
  switch (ease) {
    case 0:
      return applyTrans(t, trans)
    case 1:
      return 1 - applyTrans(1 - t, trans)
    case 2:
      return t < 0.5
        ? applyTrans(t * 2, trans) / 2
        : 1 - applyTrans((1 - t) * 2, trans) / 2
    case 3:
      return t < 0.5
        ? (1 - applyTrans(1 - t * 2, trans)) / 2
        : 0.5 + applyTrans(t * 2 - 1, trans) / 2
    default:
      return t
  }
}

// ── Path Builder ─────────────────────────────────────────────────────────────

export function buildPath(
  markerData: MarkerData,
  totalFrames: number,
): Float32Array {
  const path = new Float32Array(totalFrames).fill(-1)

  const markers = Object.entries(markerData)
    .map(([k, v]) => ({
      frame: parseInt(k),
      depth: v[0],
      trans: v[1],
      ease: v[2],
      aux: v[3],
    }))
    .sort((a, b) => a.frame - b.frame)

  if (markers.length === 0) return path

  for (let i = 0; i < markers.length; i++) {
    const cur = markers[i]
    const next = markers[i + 1]
    path[cur.frame] = cur.depth
    if (!next) {
      for (let f = cur.frame + 1; f < totalFrames; f++) path[f] = cur.depth
      break
    }
    const steps = next.frame - cur.frame
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      path[cur.frame + s] =
        cur.depth +
        (next.depth - cur.depth) * godotEase(t, next.trans, next.ease)
    }
  }
  return path
}

// ── Marker helpers ───────────────────────────────────────────────────────────

/** Parse a raw markerData object into a sorted marker array. */
export function markersFromData(markerData: MarkerData): Marker[] {
  return Object.entries(markerData)
    .map(([k, v]) => ({
      frame: parseInt(k),
      depth: v[0],
      trans: v[1],
      ease: v[2],
      aux: v[3],
    }))
    .sort((a, b) => a.frame - b.frame)
}

/** Compute peak marker frames — markers where depth > both neighbours. */
export function findPeaks(sortedMarkers: { frame: number; depth: number }[]): number[] {
  const peaks: number[] = []
  for (let i = 1; i < sortedMarkers.length - 1; i++) {
    if (
      sortedMarkers[i].depth > sortedMarkers[i - 1].depth &&
      sortedMarkers[i].depth > sortedMarkers[i + 1].depth
    ) {
      peaks.push(sortedMarkers[i].frame)
    }
  }
  return peaks
}

/**
 * Peaks from a raw marker map, where the depth is *coerced* (`parseFloat(…) || 0`)
 * rather than trusted. Kept separate from `findPeaks` because the two call
 * sites disagree on how a non-numeric depth should be treated, and the playlist
 * page depends on the coercing form.
 */
export function peaksFromMarkerData(markerData: MarkerData): number[] {
  return findPeaks(
    Object.entries(markerData)
      .map(([k, v]) => ({
        frame: parseInt(k),
        depth: parseFloat(String(v[0])) || 0,
      }))
      .sort((a, b) => a.frame - b.frame),
  )
}

// ── Version normalisation ────────────────────────────────────────────────────

/**
 * Accepts every `.bx` flavour: plain v1 (flat marker map), `version: 2` at the
 * root, and the newer `meta: { version: 2 }` structure.
 */
export function parseBx(parsed: unknown): {
  markerData: MarkerData
  effects: BxEffect[]
} {
  const p = (parsed ?? {}) as RawBx
  const isBx2 = p.version === 2 || p.meta?.version === 2
  const markerData = (isBx2 ? p.markers : (parsed as MarkerData)) ?? {}
  const effects = isBx2 && Array.isArray(p.effects) ? p.effects : []
  return { markerData, effects }
}

// ── Custom font loader ────────────────────────────────────────────────────────
//
// Collects all unique font names from text effects, then tries to load each
// one from the video's own folder. Tried extensions: woff2, woff, ttf, otf.
// Silently skips fonts that are already loaded or whose file isn't found.

const _loadedFonts = new Set<string>()

export async function loadEffectFonts(
  effects: BxEffect[],
  videoFolder: string,
): Promise<void> {
  const EXTS = ['woff2', 'woff', 'ttf', 'otf']
  const BUILTIN = new Set([
    'sans-serif',
    'serif',
    'monospace',
    'cursive',
    'fantasy',
    'system-ui',
    'Arial',
    'Georgia',
    'Impact',
    'Trebuchet MS',
    'Courier New',
    'Verdana',
    'Times New Roman',
    'JetBrains Mono',
    'Rajdhani',
  ])

  const needed = new Set(
    effects
      .filter((ef) => ef.type === 'text' && ef.font)
      .map((ef) => ef.font as string)
      .filter((name) => !BUILTIN.has(name) && !_loadedFonts.has(name)),
  )

  for (const name of needed) {
    for (const ext of EXTS) {
      const url = `${VIDEO_BASE}/${encodeURIComponent(videoFolder)}/${encodeURIComponent(name)}.${ext}`
      try {
        const face = new FontFace(name, `url('${url}')`)
        await face.load()
        document.fonts.add(face)
        _loadedFonts.add(name)
        break
      } catch {
        // file not found or failed to parse — try next extension
      }
    }
  }
}
