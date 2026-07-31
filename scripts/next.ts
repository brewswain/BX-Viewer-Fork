/**
 * Thin `next` launcher. Its only job is to preload the exFAT readlink shim when
 * the repo sits on a filesystem that needs it (see exfat-readlink-shim.cjs).
 * On every other volume this spawns next verbatim and changes nothing.
 *
 * Usage: bun run scripts/next.ts <build|dev|start> [...args]
 */
import { spawn } from 'node:child_process'
import { readlinkSync } from 'node:fs'
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

if (readlinkReportsEisdir()) {
  // Forward slashes: NODE_OPTIONS treats backslashes inside quotes as escapes,
  // which mangles a Windows path. Node accepts either separator.
  const shim = fileURLToPath(new URL('./exfat-readlink-shim.cjs', import.meta.url)).replace(/\\/g, '/')
  env.NODE_OPTIONS = [env.NODE_OPTIONS, `--require "${shim}"`].filter(Boolean).join(' ')
}

const child = spawn('next', process.argv.slice(2), { stdio: 'inherit', env, shell: true })

child.on('exit', (code, signal) => {
  // Re-raise the signal rather than swallowing it, so Ctrl+C still stops the server.
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
