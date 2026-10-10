/**
 * Playlist entry identity.
 *
 * The rule: a playlist may list the same video more than once ONLY when each
 * occurrence plays a different `.bx` (a difficulty ladder: one song, Easy then
 * Hard then Extreme). An exact repeat of (video, path) is refused; playing the
 * identical track twice is the per-track repeat setting, not a second entry.
 *
 * So a video id is not an entry's identity, and anything that keys per entry
 * (repeat prefs, React keys, export resolution) goes through here or by index.
 * Pure and dependency-free so the manager, the player and the server agree.
 */

export type EntryLike =
  | string
  | { id?: string; videoId?: string; bxFile?: string | null }

export function entryVideoId(e: EntryLike): string {
  return typeof e === 'string' ? e : e.id || e.videoId || ''
}

/** The `.bx` an entry pins, or null for "the video's default". */
export function entryPinnedBx(e: EntryLike): string | null {
  return typeof e === 'string' ? null : e.bxFile || null
}

/**
 * Resolves a video's default `.bx` (its first `bxFiles` entry). Without one, an
 * unpinned entry and an entry pinning the default file look different, so pass
 * it wherever the video metas are at hand.
 */
export type DefaultBx = (videoId: string) => string | null | undefined

/** The `.bx` an entry actually plays, or '' when it cannot be told. */
export function entryEffectiveBx(e: EntryLike, defaultBx?: DefaultBx): string {
  return entryPinnedBx(e) ?? defaultBx?.(entryVideoId(e)) ?? ''
}

export type DuplicateEntry = {
  /** Index of the offending repeat. */
  index: number
  /** Index of the earlier entry it repeats. */
  firstIndex: number
  videoId: string
  bxFile: string
}

/** Entries that repeat an earlier (video, effective path) pair, in list order. */
export function findDuplicateEntries(
  entries: readonly EntryLike[],
  defaultBx?: DefaultBx,
): DuplicateEntry[] {
  const seen = new Map<string, number>()
  const out: DuplicateEntry[] = []
  entries.forEach((e, index) => {
    const videoId = entryVideoId(e)
    if (!videoId) return
    const bxFile = entryEffectiveBx(e, defaultBx)
    const key = JSON.stringify([videoId, bxFile])
    const firstIndex = seen.get(key)
    if (firstIndex === undefined) seen.set(key, index)
    else out.push({ index, firstIndex, videoId, bxFile })
  })
  return out
}

export function describeDuplicates(dups: readonly DuplicateEntry[]): string {
  const parts = dups.map(
    (d) =>
      `#${d.index + 1} repeats #${d.firstIndex + 1} (${d.videoId}${d.bxFile ? ` / ${d.bxFile}` : ''})`,
  )
  return (
    `A video may appear more than once only with a different path each time: ${parts.join('; ')}. ` +
    'Use the per-track repeat to play the same path twice.'
  )
}

/** Drops exact repeats, keeping the first occurrence. */
export function dedupeEntries<T extends EntryLike>(
  entries: readonly T[],
  defaultBx?: DefaultBx,
): T[] {
  const drop = new Set(findDuplicateEntries(entries, defaultBx).map((d) => d.index))
  return entries.filter((_, i) => !drop.has(i))
}

/** First of `files` no entry of the video is using yet, or null when all are. */
export function nextUnusedBx(files: readonly string[], used: readonly string[]): string | null {
  return files.find((f) => !used.includes(f)) ?? null
}

/**
 * One stable key per track, for state that must follow an entry rather than a
 * video (per-track repeat). A video listed once keys by its bare id, so prefs
 * saved before repeats were allowed still apply; a repeated one adds its path.
 * A hand-edited exact repeat still gets a distinct key from its position.
 */
export function trackKeys(
  tracks: readonly { videoId: string; bxFile: string | null }[],
): string[] {
  const counts = new Map<string, number>()
  for (const t of tracks) counts.set(t.videoId, (counts.get(t.videoId) ?? 0) + 1)
  const used = new Set<string>()
  return tracks.map((t, i) => {
    let key = (counts.get(t.videoId) ?? 0) > 1 ? `${t.videoId}#${t.bxFile ?? ''}` : t.videoId
    if (used.has(key)) key = `${key}@${i}`
    used.add(key)
    return key
  })
}
