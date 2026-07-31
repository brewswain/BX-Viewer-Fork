#!/usr/bin/env bun
/**
 * BounceX Viewer Updater — port of scripts/update.py (Bun/TypeScript).
 *
 * 1. Ensures git is installed (installs it if not)
 * 2. Ensures this is a git repo pointed at the right remote (initialises if not)
 * 3. Runs git pull --ff-only origin main (or resets to origin/main on first init)
 * 4. Reinstalls dependencies and rebuilds — the app is a Next.js build now, so a
 *    bare git pull leaves it running stale/broken code.
 *
 * User data (videos/, playlists/, config.json) is never touched — git only
 * modifies files it tracks, and those directories are in .gitignore.
 */

import { spawnSync } from 'node:child_process'
import { accessSync, appendFileSync, constants, existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..') // scripts/ -> project root
const GITHUB_REPO = 'brewswain/BX-Viewer-Fork'
const REMOTE_URL = `https://github.com/${GITHUB_REPO}.git`
const BRANCH = 'main'

const GITIGNORE_LINES = [
  'videos/',
  'playlists/',
  'node_modules/',
  '.next/',
  'config.json',
  'Packaging/',
  'Tools/',
]

// ── Helpers ───────────────────────────────────────────────────────────────────

const ok = (text: string) => console.log(`  OK  ${text}`)
const info = (text: string) => console.log(`      ${text}`)
const step = (text: string) => console.log(`  >>  ${text}`)
const fail = (text: string) => console.error(`  !!  ${text}`)

/** Run a command with inherited stdio. Throws on non-zero exit. */
function run(args: string[], quiet = false): void {
  const [cmd, ...rest] = args
  const r = spawnSync(cmd!, rest, { cwd: ROOT, stdio: quiet ? 'ignore' : 'inherit' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} exited with code ${r.status}`)
}

/** Run a command with inherited stdio, returning its exit code instead of throwing. */
function runStatus(args: string[]): number {
  const [cmd, ...rest] = args
  const r = spawnSync(cmd!, rest, { cwd: ROOT, stdio: 'inherit' })
  if (r.error) return 1
  return r.status ?? 1
}

/** Run a command and return [trimmed stdout, exit code]. */
function runOut(args: string[]): [string, number] {
  const [cmd, ...rest] = args
  const r = spawnSync(cmd!, rest, { cwd: ROOT, encoding: 'utf8' })
  if (r.error) return ['', 1]
  return [(r.stdout ?? '').trim(), r.status ?? 1]
}

/** Minimal `shutil.which` — scans PATH (honouring PATHEXT on Windows). */
function which(cmd: string): string | null {
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        /* keep looking */
      }
    }
  }
  return null
}

/** Read a line from stdin. Bun's `prompt` returns null at EOF. */
function ask(message: string): string {
  return (prompt(message) ?? '').trim().toLowerCase()
}

function pause(): void {
  if (!process.argv.includes('--no-pause')) ask('\n      Press Enter to exit...')
}

// ── Git installation ──────────────────────────────────────────────────────────

/** Return the git executable path, or null if not found. */
function findGit(): string | null {
  const found = which('git')
  if (found) return found
  // Common Windows install locations
  for (const p of ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe']) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * Make sure git is available.
 * If not found, describes what it will do and asks the user before touching
 * anything. Returns the git path, or exits.
 */
function ensureGit(): string {
  let git = findGit()
  if (git) {
    const [ver] = runOut([git, '--version'])
    ok(`git found: ${ver}`)
    return git
  }

  fail('git is not installed.')
  console.log()

  // ── Describe what we'd do, then ask ────────────────────────────────────────
  const plat = process.platform
  if (plat === 'win32') {
    info('git can be installed via winget:')
    info('  winget install Git.Git')
  } else if (plat === 'darwin') {
    if (which('brew')) {
      info('git can be installed via Homebrew:')
      info('  brew install git')
    } else {
      info('git can be installed via Xcode Command Line Tools.')
      info('This will open an install dialog.')
    }
  } else {
    const mgr = ['apt-get', 'dnf', 'pacman', 'zypper'].find((m) => which(m))
    if (mgr) {
      info(`git can be installed via ${mgr}:`)
      info(`  sudo ${mgr} install git`)
    } else {
      fail('No supported package manager found.')
      info('Install git manually from https://git-scm.com/ then re-run.')
      pause()
      process.exit(1)
    }
  }

  console.log()
  if (ask('  Install git now? (Y/N): ') !== 'y') {
    console.log()
    info('Install git from https://git-scm.com/ then run the updater again.')
    pause()
    process.exit(1)
  }

  // ── Carry out the install ──────────────────────────────────────────────────
  console.log()
  if (plat === 'win32') {
    step('Running: winget install Git.Git')
    const code = runStatus([
      'winget', 'install', 'Git.Git',
      '--source', 'winget',
      '--accept-package-agreements', '--accept-source-agreements',
    ])
    if (code !== 0) {
      fail('winget install failed.')
      pause()
      process.exit(1)
    }
    ok('git installed.')
    info('Close this window and re-run the updater so git is on PATH.')
    pause()
    process.exit(0)
  } else if (plat === 'darwin') {
    if (which('brew')) {
      step('Running: brew install git')
      if (runStatus(['brew', 'install', 'git']) !== 0) {
        fail('brew install failed.')
        pause()
        process.exit(1)
      }
    } else {
      step('Running: xcode-select --install')
      runStatus(['xcode-select', '--install'])
      info('Complete the Xcode CLT dialog, then re-run the updater.')
      pause()
      process.exit(0)
    }
  } else {
    const installers: [string, string[]][] = [
      ['apt-get', ['sudo', 'apt-get', 'install', 'git']],
      ['dnf', ['sudo', 'dnf', 'install', 'git']],
      ['pacman', ['sudo', 'pacman', '-S', 'git']],
      ['zypper', ['sudo', 'zypper', 'install', 'git']],
    ]
    for (const [mgr, args] of installers) {
      if (!which(mgr)) continue
      step(`Running: sudo ${mgr} install git`)
      if (runStatus(args) !== 0) {
        fail(`${mgr} install failed.`)
        pause()
        process.exit(1)
      }
      ok('git installed.')
      break
    }
  }

  git = findGit()
  if (!git) {
    fail('git still not found after install. Please restart and try again.')
    pause()
    process.exit(1)
  }
  return git
}

// ── .gitignore ────────────────────────────────────────────────────────────────

function ensureGitignore(): void {
  const gi = join(ROOT, '.gitignore')
  let existing = ''
  try {
    existing = readFileSync(gi, 'utf8')
  } catch {
    /* no .gitignore yet */
  }
  const added = GITIGNORE_LINES.filter((line) => !existing.includes(line))
  if (added.length) {
    const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
    appendFileSync(gi, `${prefix}${added.join('\n')}\n`, 'utf8')
    ok(`.gitignore updated (${added.length} entries added)`)
  } else {
    ok('.gitignore already up to date')
  }
}

// ── Repo initialisation ───────────────────────────────────────────────────────

function isGitRepo(git: string): boolean {
  const [, code] = runOut([git, 'rev-parse', '--is-inside-work-tree'])
  return code === 0
}

/**
 * If ROOT is already a git repo, just make sure origin points at this fork.
 * Otherwise init it and point it at the remote — ready for a pull.
 * Returns true on a fresh init (caller must hard-reset instead of pulling).
 */
function ensureRepo(git: string): boolean {
  if (isGitRepo(git)) {
    const [remoteUrl, code] = runOut([git, 'remote', 'get-url', 'origin'])
    if (code !== 0) {
      step('Adding remote origin...')
      run([git, 'remote', 'add', 'origin', REMOTE_URL])
      ok(`Remote set to ${REMOTE_URL}`)
    } else if (!sameRemote(remoteUrl, REMOTE_URL)) {
      // Clones made before the fork move still point at the upstream repo.
      step('Updating remote URL...')
      info(`was: ${remoteUrl}`)
      run([git, 'remote', 'set-url', 'origin', REMOTE_URL])
      ok(`Remote updated to ${REMOTE_URL}`)
    } else {
      ok(`Remote OK (${REMOTE_URL})`)
    }
    return false // not a fresh init
  }

  step('Initialising git repository...')
  ensureGitignore()
  run([git, 'init', '-b', BRANCH])
  run([git, 'remote', 'add', 'origin', REMOTE_URL])
  ok(`Repository initialised, remote -> ${REMOTE_URL}`)
  return true // fresh init — caller needs a hard reset instead of a pull
}

/** Compare remotes ignoring a trailing `.git`, trailing slash and case. */
function sameRemote(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

// ── Update ────────────────────────────────────────────────────────────────────

function doUpdate(git: string, freshInit: boolean): boolean {
  step(`Fetching ${REMOTE_URL} ...`)
  try {
    run([git, 'fetch', 'origin', BRANCH], true)
  } catch {
    fail('Fetch failed. Check your internet connection and try again.')
    return false
  }
  ok('Fetch complete')

  if (freshInit) {
    // No local history yet — hard-reset to the remote branch.
    // Untracked files (videos/, node_modules/, etc.) are left alone by reset --hard.
    step('Aligning working tree to remote...')
    run([git, 'reset', '--hard', `origin/${BRANCH}`])
    run([git, 'branch', '--set-upstream-to', `origin/${BRANCH}`, BRANCH])
    ok('Working tree aligned to remote')
  } else {
    step('Pulling latest changes...')
    // Use --ff-only so we never silently create a merge commit.
    // If local edits conflict, tell the user rather than mangling their tree.
    if (runStatus([git, 'pull', '--ff-only', 'origin', BRANCH]) !== 0) {
      console.log()
      fail('Fast-forward pull failed.')
      info('Your local files have diverged from the remote.')
      info('To force-reset to the latest version (losing local changes):')
      info(`  git fetch origin && git reset --hard origin/${BRANCH}`)
      return false
    }
    ok('Pull complete')
  }
  return true
}

// ── Dependencies + build ──────────────────────────────────────────────────────

/**
 * Install dependencies, tolerating volumes that cannot host bun's lockfile.
 *
 * `--frozen-lockfile` is the default because it performs no lockfile write:
 * on exFAT (and other filesystems without atomic replace) a plain `bun install`
 * unpacks every package correctly but still exits 1 with
 * "Failed to replace old lockfile with new lockfile on disk".
 *
 * Frozen mode legitimately refuses when package.json has moved on from bun.lock —
 * which is exactly what a fresh `git pull` can do — so fall back to a normal
 * install, and treat its failure as cosmetic if the packages actually landed.
 */
function installDeps(bun: string): boolean {
  step('Installing dependencies (bun install --frozen-lockfile) ...')
  if (runStatus([bun, 'install', '--frozen-lockfile']) === 0) {
    ok('Dependencies installed')
    return true
  }

  step('Lockfile does not match package.json — retrying without --frozen-lockfile ...')
  if (runStatus([bun, 'install']) === 0) {
    ok('Dependencies installed')
    return true
  }

  if (existsSync(join(ROOT, 'node_modules', 'next'))) {
    info('bun could not rewrite bun.lock (exFAT volumes lack the atomic replace it needs).')
    info('The packages themselves installed fine — continuing.')
    return true
  }

  fail('bun install failed.')
  info('Fix the errors above, then run the updater again.')
  return false
}

/**
 * A pull can change package.json and any source file, so the app has to be
 * reinstalled and rebuilt before `bun run start` will serve the new version.
 */
function installAndBuild(): boolean {
  // Under Bun, execPath is the bun binary — a reliable fallback if PATH is odd.
  const bun = which('bun') ?? process.execPath

  if (!installDeps(bun)) return false

  step('Building the app (bun run build) ...')
  if (runStatus([bun, 'run', 'build']) !== 0) {
    fail('Build failed.')
    info('The app may still start on the previous build, but it will be out of date.')
    return false
  }
  ok('Build complete')
  return true
}

// ── Entry point ───────────────────────────────────────────────────────────────

console.log()
console.log('  BounceX Viewer - Updater')
console.log('  ' + '='.repeat(24))
console.log()

step('Checking for git...')
const gitExe = ensureGit()

step('Checking repository...')
const freshInit = ensureRepo(gitExe)

if (doUpdate(gitExe, freshInit) && installAndBuild()) {
  console.log()
  console.log('  Update complete!')
} else {
  console.log()
  fail('Update did not complete. See messages above.')
  process.exitCode = 1
}

pause()
