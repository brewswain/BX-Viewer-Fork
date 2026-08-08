/**
 * Filenames for an OSSM Sauce export.
 *
 * OSSM Sauce keeps every path in one flat `Paths/` folder and resolves each
 * playlist line against it by name alone (`_resolve_storage_path`,
 * `ossm_sauce.gd:2315-2323` — folder plus name, nothing else), so an
 * exported name has to identify its video on its own. Copying source names
 * verbatim would put files like `Hard.bx` and `Medium.bx` in there — ambiguous
 * in the app's Add Path list, and one name clash away from silently
 * overwriting an unrelated video's path.
 *
 * Pure module: imported by both the route handlers and the browser.
 */

import type { OssmEntry, OssmFlags } from './types'

/** Lowercase, ASCII-ish, separator-free. Mirrors `titleToFolderId`. */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** `.bx` / `.funscript` — OSSM Sauce reads both, so the source extension wins. */
export function pathExtension(bxFile: string): string {
  const dot = bxFile.lastIndexOf('.')
  const ext = dot === -1 ? '' : bxFile.slice(dot).toLowerCase()
  return ext === '.funscript' ? '.funscript' : '.bx'
}

function stripExtension(bxFile: string): string {
  const dot = bxFile.lastIndexOf('.')
  return dot === -1 ? bxFile : bxFile.slice(0, dot)
}

/**
 * The name a video's path takes inside `Paths/`.
 *
 * Single-variant videos get the bare video slug (`hope.bx`). Videos that ship
 * several paths get the variant appended, because "hard" alone says nothing
 * about which video it belongs to (`hopeless-hard.bx`). The variant part comes
 * from the .bx filename rather than the label: labels are prose
 * ("Easy - Things&Stuff") and slugify into something much noisier.
 */
export function ossmPathName(
  videoId: string,
  bxFile: string,
  variantCount: number,
): string {
  const base = slugify(videoId) || 'path'
  const ext = pathExtension(bxFile)
  if (variantCount <= 1) return base + ext

  const variant = slugify(stripExtension(bxFile))
  // A variant that slugs away to nothing, or that just repeats the video slug,
  // would only add a dangling separator.
  if (!variant || variant === base) return base + ext
  return `${base}-${variant}${ext}`
}

/**
 * OSSM Sauce derives a playlist's displayed name from its `.bxpl` filename and
 * strips these same characters when saving one itself (`save_playlist.gd:7`), so
 * an export it can't have produced is an export we shouldn't write.
 */
export function sanitizeBxplName(raw: string): string {
  const stripped = (raw || '')
    .replace(/[\\/:*?"<>|\r\n]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Trailing dots and spaces are legal in a zip entry but not on Windows.
    .replace(/[. ]+$/, '')
  return stripped || 'playlist'
}

/** Insert a disambiguating suffix ahead of the extension. */
export function suffixName(name: string, suffix: string): string {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return `${name}-${suffix}`
  return `${name.slice(0, dot)}-${suffix}${name.slice(dot)}`
}

/**
 * The v2 `version` value. Deliberately not bumped when a key is added:
 * `_parse_v2_entry` ignores keys it doesn't recognise, so an older build drops
 * the unknown field and still loads the playlist, where a higher version makes
 * it refuse the file outright (`playlist_format.gd:111-113`).
 */
const BXPL_VERSION = 2

/**
 * Whether this export has an opinion about shuffle and loop — which is exactly
 * the question of whether it is written as v2. Both fields are optional and
 * nullable, so normalise here rather than at every caller.
 */
export function statesFlags(flags: OssmFlags): boolean {
  return (flags.shuffle ?? null) !== null || (flags.loop ?? null) !== null
}

/**
 * The `.bxpl` body, in whichever of the app's two formats says what this export
 * actually means.
 *
 * **v1 — bare filenames, one per line — whenever the flags are unset.** Not a
 * fallback: v1 is the only format that can decline to state shuffle and loop.
 * `_parse_v2` reports `has_flags` as true for every v2 file it reads
 * (`playlist_format.gd:135`), and `apply_playlist` takes that as permission to
 * write both toggles (`ossm_sauce.gd:1019-1022`), so a v2 export cannot stay
 * silent — it would assert `false` twice and turn off a shuffle the user never
 * touched. Legacy files carry no flags and the app leaves them alone, which is
 * exactly what "no opinion" should do.
 *
 * **v2 JSON as soon as either flag is set**, because now there is something to
 * say. Entries carry only `path`: the app's own writer omits the repeat keys at
 * their defaults too (`serialize`, `playlist_format.gd:43-52`), so a plain queue
 * round-trips to a minimal file and a real repeat setting stands out in a diff.
 *
 * Reading is unambiguous either way — `deserialize` sniffs the first
 * non-whitespace character, takes `{` as v2, and otherwise falls through to the
 * legacy line parser (`playlist_format.gd:83-89`) — and the app reads both
 * formats forever.
 *
 * One wrinkle, until the app can tell an absent flag from a false one: setting
 * just one of the pair still writes the other as `false`, because v2 has no way
 * to omit it. The overlay therefore sets them together or not at all.
 */
export function bxplBody(playlist: OssmFlags & { entries: OssmEntry[] }): string {
  const { entries } = playlist

  // LF-terminated, including the last line: `_parse_legacy` skips blank lines,
  // so the trailing newline is free, and every other writer here ends its files.
  if (!statesFlags(playlist)) {
    return entries.map((e) => `${e.path}\n`).join('')
  }

  const root = {
    version: BXPL_VERSION,
    shuffle: playlist.shuffle === true,
    loop: playlist.loop === true,
    // Rebuilt field by field rather than spread, so a key added to `OssmEntry`
    // has to be opted in to the file instead of leaking into it.
    entries: entries.map((e) => ({ path: e.path })),
  }
  // Tab-indented and in insertion order, matching the app's
  // `JSON.stringify(root, "\t", false)` — Godot's third argument is `sort_keys`,
  // so passing false leaves the key order alone. `save_playlist.gd:30` writes
  // with `store_line`, which appends a newline; matching it keeps a diff against
  // an app-saved playlist empty.
  return `${JSON.stringify(root, null, '\t')}\n`
}
