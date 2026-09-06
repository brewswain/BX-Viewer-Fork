/**
 * Reserved-category tag matching for the browse filters.
 *
 * The three reserved categories (video type, difficulty, song quantity) are
 * fixed chip lists in FilterBar rather than facets derived from the data, so
 * their casing is the author's and the tags' casing is the import's. Those
 * disagree constantly: every LustfulLoops entry carries 'dildo hero' against a
 * 'Dildo Hero' chip, and nothing in the library carries 'Compilation' or
 * 'Single Song' in the chip's casing at all. Matched exactly, those chips
 * emptied the grid instead of filtering it.
 *
 * FilterBar already folds case for the mirror-image decision — which tags are
 * general rather than reserved — so folding here keeps the two consistent.
 * The general tag chips are built from the data itself and stay exact.
 */

type Tagged = { tags?: string[] }

/** True when any of the entry's tags matches a selected chip, ignoring case. */
export function matchesCategory(tags: string[] | undefined, selected: Set<string>): boolean {
  if (selected.size === 0) return true
  const wanted = new Set([...selected].map((t) => t.toLowerCase()))
  return (tags || []).some((t) => wanted.has(t.toLowerCase()))
}

/** An empty selection is "no filter", so the list passes through untouched. */
export function filterByCategory<T extends Tagged>(list: T[], selected: Set<string>): T[] {
  if (selected.size === 0) return list
  const wanted = new Set([...selected].map((t) => t.toLowerCase()))
  return list.filter((v) => (v.tags || []).some((t) => wanted.has(t.toLowerCase())))
}
