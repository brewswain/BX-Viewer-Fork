'use client'

/**
 * The ad-hoc "play all" playlist — whatever the browse page has on screen,
 * handed to the playlist page without writing a playlist to disk.
 *
 * It travels in sessionStorage rather than the URL because the selection is
 * potentially the whole library: hundreds of folder ids, far past a usable
 * query string. sessionStorage rather than localStorage because it is a
 * snapshot of a filter, not a saved playlist — it should die with the tab. The
 * URL still carries `?p=__all__` as the handle, and the playlist page falls
 * back to the full manifest when the entry is missing (link opened in a fresh
 * tab, storage cleared), so it never dead-ends.
 */

/** Reserved playlist id. Real ids are folder names under `public/playlists`. */
export const QUICK_PLAYLIST_ID = '__all__'

const KEY = 'bx_quick_playlist'

export const QUICK_PLAYLIST_FALLBACK_TITLE = 'All videos'

export type QuickPlaylist = {
  title: string
  /** Video folder ids, in the order the browse grid showed them. */
  folders: string[]
}

/** Split out from the load so the validation is testable without a DOM. */
export function parseQuickPlaylist(raw: string | null): QuickPlaylist | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<QuickPlaylist>
    const folders = Array.isArray(parsed.folders)
      ? parsed.folders.filter((f): f is string => typeof f === 'string' && f !== '')
      : []
    // An empty list is indistinguishable from no list: both mean "fall back to
    // the whole library" rather than "play nothing".
    if (folders.length === 0) return null
    return {
      title:
        typeof parsed.title === 'string' && parsed.title
          ? parsed.title
          : QUICK_PLAYLIST_FALLBACK_TITLE,
      folders,
    }
  } catch {
    return null
  }
}

export function saveQuickPlaylist(playlist: QuickPlaylist): void {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(KEY, JSON.stringify(playlist))
  } catch {
    // Storage blocked or full. The playlist page then plays the whole library,
    // which is the worst case anyone pressing "play all" asked for anyway.
  }
}

export function loadQuickPlaylist(): QuickPlaylist | null {
  if (typeof window === 'undefined') return null
  try {
    return parseQuickPlaylist(sessionStorage.getItem(KEY))
  } catch {
    return null
  }
}
