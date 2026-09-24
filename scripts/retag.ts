/**
 * Rewrites every video and playlist meta.json onto the tag vocabulary in
 * lib/browse/facets.ts. The library is gitignored, so this has to run once on
 * each machine (and again after an import brings in raw tags). Idempotent.
 *
 *   bun run retag          apply
 *   bun run retag --dry    print what would change
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { normalizeTags } from '../lib/browse/facets'

const dry = process.argv.includes('--dry')
let changed = 0

for (const base of ['videos', 'playlists']) {
  const dir = join(process.cwd(), base)
  if (!existsSync(dir)) continue
  for (const folder of readdirSync(dir)) {
    const file = join(dir, folder, 'meta.json')
    if (!existsSync(file)) continue
    const meta = JSON.parse(readFileSync(file, 'utf8'))
    const before: string[] = meta.tags ?? []
    const after = normalizeTags(folder, meta)
    if (JSON.stringify(before) === JSON.stringify(after)) continue
    changed++
    console.log(`${base}/${folder}\n  - ${before.join(', ')}\n  + ${after.join(', ')}`)
    if (!dry) writeFileSync(file, JSON.stringify({ ...meta, tags: after }, null, 2))
  }
}

console.log(`${changed} ${dry ? 'would change' : 'changed'}`)
