'use client'

/**
 * Shared playback state for the playlist page: loop, shuffle, per-track repeat,
 * and the play order they produce.
 *
 * It lives outside React because it has two kinds of reader that a `useState`
 * cannot serve at once. The control bar and the sidebar render from it, so it
 * has to be reactive; the engine's `onEnded` callback is created once per
 * playlist and reads it at event time, so it has to be readable imperatively
 * and always current. The page previously kept a state/ref pair for exactly
 * this reason — one store removes the chance of the two drifting.
 *
 * A module singleton rather than a provider: one playlist plays at a time, and
 * `init()` resets it. `useSyncExternalStore` is React's own primitive for this
 * shape, so it costs no dependency.
 */

import { useSyncExternalStore } from 'react'

import {
  cycleBarLoop,
  cycleRowLoop,
  EMPTY_PLAYLIST_PREFS,
  loadPlaylistPrefs,
  savePlaylistPrefs,
  sequentialOrder,
  shuffledOrder,
  type PlaylistPrefs,
} from './playback'

export type PlaybackState = {
  playlistId: string | null
  prefs: PlaylistPrefs
  /** Track indices in play order — shuffled or the identity permutation. */
  order: number[]
  /** Where the playing track sits *in `order`*, not its playlist index. */
  position: number
  /** Playlist index of the playing track. */
  currentIndex: number
  /** Folder id of the playing track; '' until the first track loads. */
  currentFolder: string
  /** Extra plays the playing track has had, for resolving a `once` repeat. */
  repeatsUsed: number
}

const INITIAL: PlaybackState = {
  playlistId: null,
  prefs: EMPTY_PLAYLIST_PREFS,
  order: [],
  position: 0,
  currentIndex: 0,
  currentFolder: '',
  repeatsUsed: 0,
}

let state: PlaybackState = INITIAL
const listeners = new Set<() => void>()

function set(patch: Partial<PlaybackState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

/** Every prefs write persists — they are cheap and losing them is annoying. */
function setPrefs(prefs: PlaylistPrefs): void {
  set({ prefs })
  if (state.playlistId) savePlaylistPrefs(state.playlistId, prefs)
}

export function getPlaybackState(): PlaybackState {
  return state
}

/**
 * Point the store at a playlist and restore its saved prefs. Called from an
 * effect, not during render: `loadPlaylistPrefs` reads localStorage, which does
 * not exist on the server.
 */
export function initPlayback(playlistId: string): void {
  set({
    ...INITIAL,
    playlistId,
    prefs: loadPlaylistPrefs(playlistId),
  })
}

/** Build the play order once the track list is known. */
export function setTrackCount(count: number): void {
  set({
    order: state.prefs.shuffle ? shuffledOrder(count) : sequentialOrder(count),
    position: 0,
  })
}

/**
 * Record which track is playing. `position` is derived from the order rather
 * than incremented, because a track reached by clicking the sidebar is not
 * necessarily the next one in play order.
 */
export function setCurrentTrack(index: number, folder: string): void {
  const at = state.order.indexOf(index)
  set({
    currentIndex: index,
    currentFolder: folder,
    position: at >= 0 ? at : 0,
    repeatsUsed: 0,
  })
}

export function noteRepeat(): void {
  set({ repeatsUsed: state.repeatsUsed + 1 })
}

/** Reshuffle on every pass, or repeat-all would replay one fixed order. */
export function reshuffle(count: number): void {
  set({ order: shuffledOrder(count) })
}

export function cycleLoop(): void {
  setPrefs(cycleBarLoop(state.prefs, state.currentFolder))
}

export function cycleTrackRepeat(folder: string): void {
  // Changing the setting mid-play restarts the allowance for this pass.
  if (folder === state.currentFolder) set({ repeatsUsed: 0 })
  setPrefs(cycleRowLoop(state.prefs, folder, state.currentFolder))
}

/**
 * Shuffle rebuilds the order and re-derives the position in one step, so the
 * control bar and the engine can never see a flipped flag against a stale
 * order. The playing track is pinned to the front so flipping shuffle mid-video
 * does not cut it off; unshuffling restores playlist order around it.
 */
export function toggleShuffle(count: number): void {
  const shuffle = !state.prefs.shuffle
  const order = shuffle
    ? shuffledOrder(count, state.currentIndex)
    : sequentialOrder(count)
  const at = order.indexOf(state.currentIndex)
  set({ order, position: at >= 0 ? at : 0 })
  setPrefs({ ...state.prefs, shuffle })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): PlaybackState {
  return state
}

/** Server render has no localStorage, so it always sees the empty state. */
function getServerSnapshot(): PlaybackState {
  return INITIAL
}

export function usePlayback(): PlaybackState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
