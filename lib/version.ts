/**
 * Monotonic counter bumped on every manager write. The browse page polls
 * /api/manager/version every 2s and reloads its manifest when this changes.
 *
 * Stashed on globalThis so Next's dev-mode module reloading doesn't reset it
 * mid-session (which would look like a spurious change to the poller).
 */
const KEY = '__bxManagerVersion'

type VersionGlobal = typeof globalThis & { [KEY]?: number }

export function getVersion(): number {
  const g = globalThis as VersionGlobal
  if (typeof g[KEY] !== 'number') g[KEY] = 0
  return g[KEY]!
}

export function bumpVersion(): number {
  const g = globalThis as VersionGlobal
  g[KEY] = getVersion() + 1
  return g[KEY]!
}
