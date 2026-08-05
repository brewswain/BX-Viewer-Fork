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
 * `.bxpl` body: one entry per line, each a bare filename resolved against
 * `Paths/`. This is the app's legacy v1 format — it writes v2 JSON now
 * (`save_playlist.gd:30` → `PlaylistFormat.serialize`) — but still reads v1:
 * `deserialize` sniffs the first non-whitespace character for `{` and falls
 * back to `_parse_legacy` (`playlist_format.gd:68-74`, `164-191`). LF and a
 * trailing newline are what that parser expects; blank lines are skipped.
 */
export function bxplBody(lines: string[]): string {
  return lines.map((l) => `${l}\n`).join('')
}
