/**
 * Shapes of the JSON the player consumes: `.bx` marker maps (v1 + v2), bx2
 * effects, and the `meta.json` files for videos and playlists.
 *
 * Everything is optional-by-default because these files are hand-authored and
 * the legacy player tolerated missing fields; the port must too.
 */

/** `.bx` marker map: frame number (as a string key) → `[depth, trans, ease, aux]`. */
export type MarkerData = Record<string, number[]>

export type Marker = {
  frame: number
  depth: number
  trans: number
  ease: number
  aux?: number
}

/** A bx2 effect. `type` is one of `text` | `pathColor` | `pathSpeed`. */
export type BxEffect = {
  type: string
  startFrame: number
  endFrame: number
  fadeIn?: number
  fadeOut?: number
  // pathColor
  pathColor?: string
  ballColor?: string
  bgColor?: string
  // pathSpeed
  speed?: number
  // text
  text?: string
  font?: string
  fontSize?: number
  posX?: number
  posY?: number
  color?: string
  opacity?: number
  strokeWidth?: number
  strokeColor?: string
}

/**
 * Raw parse result of a `.bx` file, before version normalisation. A v1 file is
 * a bare `MarkerData` object, so every v2 field is optional.
 */
export type RawBx = {
  version?: number
  meta?: { version?: number }
  markers?: MarkerData
  effects?: BxEffect[]
}

export type BxFileRef = {
  label?: string
  file: string
}

export type VideoMeta = {
  title?: string
  videoFile?: string
  videoCreator?: string
  pathCreator?: string
  thumbnail?: string
  description?: string | string[]
  tags?: string[]
  highlightedTags?: string[]
  bpm?: number | string
  duration?: number
  durationSecs?: number
  /** Path start offset. Watch treats it as ms, playlist as seconds (legacy quirk). */
  offset?: number
  bxFile?: string
  bxFiles?: BxFileRef[]
}

export type PlaylistEntry = string | { id?: string; videoId?: string; bxFile?: string }

export type PlaylistMeta = {
  title?: string
  description?: string
  videos?: PlaylistEntry[]
}

/** A `.bx` source resolved for playback (watch page keeps one per meta.bxFiles entry). */
export type BxSource = {
  label: string
  file: string
  data: MarkerData
  effects: BxEffect[]
  peaks: number[]
  path?: Float32Array
}

export type Rgb = [number, number, number]
