/**
 * Stamps a fresh CACHE_NAME into public/sw.js so a restart invalidates the
 * previous service-worker cache. Port of scripts/bump-sw.py.
 *
 * The declaration is stripped on commit by the strip-cache-name git filter,
 * so on a fresh clone there is no line to replace — insert one.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SW = join(process.cwd(), 'public', 'sw.js')
const DECL = /^const CACHE_NAME = .*$/m
const stamp = `const CACHE_NAME = 'bx-video-v${Math.floor(Date.now() / 1000)}'`

let source: string
try {
  source = readFileSync(SW, 'utf8')
} catch {
  console.error(`bump-sw: ${SW} not found, skipping`)
  process.exit(0)
}

writeFileSync(SW, DECL.test(source) ? source.replace(DECL, stamp) : `${stamp}\n${source}`, 'utf8')
console.log(`bump-sw: ${stamp}`)
