/**
 * Loop / shuffle rules for the player, kept as pure functions so the two pages
 * that use them agree and so the branchy "what plays next" decision is testable
 * without a video element.
 *
 * Repeat is deliberately a per-track *setting* rather than a duplicated entry:
 * playlists reject duplicate videos (the manager's pool disables an already
 * added one), so wanting a favourite twice has to be expressed here instead.
 */

/** Per-track repeat. `once` replays a track a single extra time. */
export type LoopMode = 'off' | 'once' | 'forever'

/** Playlist-wide repeat. `one` pins playback to whatever track is loaded. */
export type PlaylistLoopMode = 'off' | 'all' | 'one'

export const LOOP_MODES: LoopMode[] = ['off', 'once', 'forever']
export const PLAYLIST_LOOP_MODES: PlaylistLoopMode[] = ['off', 'all', 'one']

export function cycleLoopMode(mode: LoopMode): LoopMode {
  return LOOP_MODES[(LOOP_MODES.indexOf(mode) + 1) % LOOP_MODES.length]
}

export function cyclePlaylistLoopMode(mode: PlaylistLoopMode): PlaylistLoopMode {
  return PLAYLIST_LOOP_MODES[
    (PLAYLIST_LOOP_MODES.indexOf(mode) + 1) % PLAYLIST_LOOP_MODES.length
  ]
}

export type AdvanceInput = {
  /** Track indices in play order — the identity permutation when unshuffled. */
  order: number[]
  /** Position *within `order`* of the track that just ended. */
  position: number
  loop: PlaylistLoopMode
  /** Repeat setting of the track that just ended. */
  trackLoop: LoopMode
  /** Extra plays the track has already had, for resolving `once`. */
  repeatsUsed: number
}

export type AdvanceResult =
  | { action: 'repeat' }
  /** `position` is the new position in `order`; `wrapped` restarted the list. */
  | { action: 'next'; position: number; wrapped: boolean }
  | { action: 'stop' }

/**
 * What to do when a track ends. Per-track repeat outranks the playlist mode: a
 * track marked `forever` is one the user pinned by hand, and `loop: 'one'` is
 * the same intent expressed transiently.
 */
export function advance(input: AdvanceInput): AdvanceResult {
  const { order, position, loop, trackLoop, repeatsUsed } = input
  if (trackLoop === 'forever') return { action: 'repeat' }
  if (trackLoop === 'once' && repeatsUsed < 1) return { action: 'repeat' }
  if (loop === 'one') return { action: 'repeat' }

  if (position + 1 < order.length)
    return { action: 'next', position: position + 1, wrapped: false }
  if (loop === 'all' && order.length > 0)
    return { action: 'next', position: 0, wrapped: true }
  return { action: 'stop' }
}

/**
 * Fisher-Yates over `0..n-1`. `pin` (a track index, not a position) is moved to
 * the front so switching shuffle on mid-track does not cut the current video
 * off, and `random` is injectable so tests do not depend on Math.random.
 */
export function shuffledOrder(
  n: number,
  pin?: number,
  random: () => number = Math.random,
): number[] {
  const order = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  if (pin != null && pin >= 0 && pin < n) {
    const at = order.indexOf(pin)
    if (at > 0) [order[0], order[at]] = [order[at], order[0]]
  }
  return order
}

/** Identity order, for when shuffle is off. */
export function sequentialOrder(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

// ── Loop controls ───────────────────────────────────────────────────────────
// The control bar and the sidebar rows are two views of one fact, not two
// settings: "repeat the track that is playing" is expressible from either, so
// each derives its displayed mode from the whole prefs object rather than from
// its own field. Without this the bar reads as dead — `all` only shows itself
// at the end of the last track — and the two can disagree about the same track.

/**
 * What the control-bar loop button shows. A playlist mode wins when set;
 * otherwise a current track pinned to `forever` from its row is the same intent
 * as repeat-one, so the bar reflects it instead of reading as off.
 */
export function barLoopMode(
  prefs: PlaylistPrefs,
  currentFolder: string,
): PlaylistLoopMode {
  if (prefs.loop !== 'off') return prefs.loop
  if (currentFolder && prefs.tracks[currentFolder] === 'forever') return 'one'
  return 'off'
}

/** What a sidebar row shows. Repeat-one is a `forever` on the playing row. */
export function rowLoopMode(
  prefs: PlaylistPrefs,
  folder: string,
  currentFolder: string,
): LoopMode {
  if (prefs.loop === 'one' && folder === currentFolder) return 'forever'
  return prefs.tracks[folder] || 'off'
}

/** Prefs after pressing the control-bar loop button: off → all → one → off. */
export function cycleBarLoop(
  prefs: PlaylistPrefs,
  currentFolder: string,
): PlaylistPrefs {
  const loop = cyclePlaylistLoopMode(barLoopMode(prefs, currentFolder))
  const tracks = { ...prefs.tracks }
  // Leaving repeat-one has to release a ∞ pinned on the playing row too, or
  // `barLoopMode` would derive `one` straight back on the next render.
  if (loop !== 'one' && currentFolder && tracks[currentFolder] === 'forever')
    delete tracks[currentFolder]
  return { ...prefs, loop, tracks }
}

/** Prefs after pressing a sidebar row's repeat button: off → once → forever. */
export function cycleRowLoop(
  prefs: PlaylistPrefs,
  folder: string,
  currentFolder: string,
): PlaylistPrefs {
  const next = cycleLoopMode(rowLoopMode(prefs, folder, currentFolder))
  const tracks = { ...prefs.tracks }
  if (next === 'off') delete tracks[folder]
  else tracks[folder] = next
  // Same fact from the other side: taking the playing row off ∞ must clear
  // playlist repeat-one, which is what was rendering that ∞.
  const loop =
    folder === currentFolder && prefs.loop === 'one' && next !== 'forever'
      ? 'off'
      : prefs.loop
  return { ...prefs, loop, tracks }
}

// ── Persistence ─────────────────────────────────────────────────────────────
// Playback preferences are per-item and open-ended, so they live under their own
// keys rather than in the single `bx_viewer_settings` blob, which is a fixed
// schema merged over DEFAULTS.

export type PlaylistPrefs = {
  loop: PlaylistLoopMode
  shuffle: boolean
  /** Per-track repeat, keyed by video folder id so reordering cannot shift it. */
  tracks: Record<string, LoopMode>
}

export const EMPTY_PLAYLIST_PREFS: PlaylistPrefs = {
  loop: 'off',
  shuffle: false,
  tracks: {},
}

const PLAYLIST_PREFS_PREFIX = 'bx_playlist_playback:'
const VIDEO_LOOP_PREFIX = 'bx_video_loop:'

function isLoopMode(v: unknown): v is LoopMode {
  return v === 'off' || v === 'once' || v === 'forever'
}

export function loadPlaylistPrefs(playlistId: string): PlaylistPrefs {
  if (typeof window === 'undefined') return { ...EMPTY_PLAYLIST_PREFS }
  try {
    const raw = localStorage.getItem(PLAYLIST_PREFS_PREFIX + playlistId)
    if (!raw) return { ...EMPTY_PLAYLIST_PREFS, tracks: {} }
    const parsed = JSON.parse(raw) as Partial<PlaylistPrefs>
    const tracks: Record<string, LoopMode> = {}
    for (const [id, mode] of Object.entries(parsed.tracks || {})) {
      if (isLoopMode(mode) && mode !== 'off') tracks[id] = mode
    }
    return {
      loop: PLAYLIST_LOOP_MODES.includes(parsed.loop as PlaylistLoopMode)
        ? (parsed.loop as PlaylistLoopMode)
        : 'off',
      shuffle: parsed.shuffle === true,
      tracks,
    }
  } catch {
    return { ...EMPTY_PLAYLIST_PREFS, tracks: {} }
  }
}

export function savePlaylistPrefs(playlistId: string, prefs: PlaylistPrefs): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(
      PLAYLIST_PREFS_PREFIX + playlistId,
      JSON.stringify(prefs),
    )
  } catch {
    /* storage full or blocked — preferences are not worth failing playback for */
  }
}

export function loadVideoLoop(videoId: string): LoopMode {
  if (typeof window === 'undefined') return 'off'
  try {
    const raw = localStorage.getItem(VIDEO_LOOP_PREFIX + videoId)
    return isLoopMode(raw) ? raw : 'off'
  } catch {
    return 'off'
  }
}

export function saveVideoLoop(videoId: string, mode: LoopMode): void {
  if (typeof window === 'undefined') return
  try {
    if (mode === 'off') localStorage.removeItem(VIDEO_LOOP_PREFIX + videoId)
    else localStorage.setItem(VIDEO_LOOP_PREFIX + videoId, mode)
  } catch {
    /* see savePlaylistPrefs */
  }
}
