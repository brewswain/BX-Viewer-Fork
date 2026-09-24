/**
 * Thin `next` launcher. Its only job is to make next work when the repo sits on
 * exFAT: preload the readlink shim (see exfat-readlink-shim.cjs) and run dev on
 * webpack. On every other volume this spawns next verbatim and changes nothing.
 *
 * Usage: bun run scripts/next.ts <build|dev|start> [...args]
 */
import { spawn } from 'node:child_process'
import { readlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

function readlinkReportsEisdir(): boolean {
  try {
    readlinkSync('package.json')
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EISDIR'
  }
}

const env = { ...process.env }
const args = process.argv.slice(2)

if (readlinkReportsEisdir()) {
  // Forward slashes: NODE_OPTIONS treats backslashes inside quotes as escapes,
  // which mangles a Windows path. Node accepts either separator.
  const shim = fileURLToPath(new URL('./exfat-readlink-shim.cjs', import.meta.url)).replace(/\\/g, '/')
  env.NODE_OPTIONS = [env.NODE_OPTIONS, `--require "${shim}"`].filter(Boolean).join(' ')

  // Turbopack dev is Rust, so the shim never reaches it, and on exFAT its
  // rebuilds panic with "Next.js package not found" (a /settings compile, then
  // every HMR update after it, each one reloading the page). Webpack goes
  // through node's fs and the shim. Builds are unaffected, so only dev switches;
  // an explicit --turbopack still wins.
  if (args[0] === 'dev' && !args.some((a) => a === '--turbopack' || a === '--turbo' || a === '--webpack')) {
    args.push('--webpack')
  }
}

/**
 * Node on next's JS entry, not `next` through a shell. On Windows the shell
 * route runs node_modules/.bin/next.cmd, a batch file, and Ctrl+C on a batch
 * file stops at cmd's "Terminate batch job (Y/N)?" prompt. With stdio shared
 * and this process waiting on it, that read as the server hanging on Ctrl+C.
 */
const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next')
const child = spawn('node', [nextBin, ...args], { stdio: 'inherit', env })

/**
 * Ctrl+C reaches every process on the console, next included, so the first one
 * just waits for next to shut itself down. If it has not within a few seconds,
 * or on a second Ctrl+C, the whole tree goes: `next dev` runs its server in a
 * grandchild, which killing the child alone would leave holding the port.
 */
let interrupts = 0
function killTree() {
  if (child.exitCode !== null || !child.pid) return
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'])
  else child.kill('SIGKILL')
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (++interrupts > 1) killTree()
    else setTimeout(killTree, 5000).unref()
  })
}

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 130 : 0))
})
