/**
 * Stamps a fresh CACHE_NAME into public/sw.js so a restart invalidates the
 * previous service-worker cache.
 *
 * The stamp is committed like any other content, so public/sw.js reads as
 * modified after every build. That churn is expected — don't stage it with
 * unrelated work. The insert branch covers a sw.js with no declaration yet.
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
