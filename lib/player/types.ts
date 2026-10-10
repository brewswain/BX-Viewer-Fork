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
  meta?: { version?: number; governorLevel?: string; capsHash?: string }
  markers?: MarkerData
  effects?: BxEffect[]
}

/**
 * The firmware governor level and caps hash a bench `.bx` was generated
 * against (BX-Studio `scripts/bench_edgecase_path.py`). Carried into the bench
 * recorder's header so the viewer log, the firmware log and the run sheet can be
 * checked against one hash. `'unknown'` on any path that does not stamp them.
 */
export type BxGovernor = { governorLevel: string; capsHash: string }

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
  /**
   * Breath cycles this video's paths deal. NOT a meta.json field: `/api/library`
   * derives it from the .bx files and stamps it on, so it is present only on
   * metas that came from that route and absent (not 0) on every ordinary video.
   * A meta fetched straight off disk will never carry it, which is why the watch
   * page's own pill counts the LOADED path instead of reading this.
   */
  poppersCycles?: number
}

export type PlaylistEntry = string | { id?: string; videoId?: string; bxFile?: string }

export type PlaylistMeta = {
  title?: string
  /** The manager saves a multi-line description as an array of lines. */
  description?: string | string[]
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
  governor?: BxGovernor
}

export type Rgb = [number, number, number]
