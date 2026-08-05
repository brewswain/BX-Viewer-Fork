/**
 * `bun test lib/ossm` — the runner is built in, same as `lib/device`.
 *
 * Two things here have no visible failure mode, which is why they are tested at
 * this level rather than through the routes:
 *
 * - **Resolution.** Writing into the wrong "Documents" produces a folder OSSM
 *   Sauce never opens. Nothing errors; the export just isn't there. The real
 *   trap is that a plain `~/Documents` *and* the OneDrive-redirected Documents
 *   can both exist, with only the latter holding the install.
 * - **Case folding.** `Hard.bx` and `hard.bx` are one file on Windows and macOS
 *   and two on Linux, so the same plan has to come out differently per platform.
 *   Platforms are faked rather than skipped — the host filesystem plays no part
 *   in the lookup rule, only the name comparison does.
 *
 * Every test works inside its own subdirectory of one `mkdtemp` root. Nothing
 * here reads or writes a real OSSM Sauce install.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  installFiles,
  planFiles,
  queryWindowsDocuments,
  resolveOssmTarget,
  type OssmResolveOptions,
} from './storage'
import type { OssmCandidate, OssmTarget } from './types'

// Creating a directory costs ~100 ms with Windows real-time scanning on, and
// these tests are all directory trees, so the default 5 s budget is too tight.
setDefaultTimeout(60_000)

let testRoot = ''
let counter = 0

beforeAll(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ossm-storage-'))
})

afterAll(async () => {
  if (testRoot) await fs.rm(testRoot, { recursive: true, force: true })
})

async function tmp(): Promise<string> {
  const dir = path.join(testRoot, `t${counter++}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/**
 * A Documents folder, optionally with an install in it. `Paths/` alone is
 * enough to count as installed; one test covers the `UserSettings.cfg` route.
 */
async function makeDocuments(root: string, installed: boolean): Promise<string> {
  const docs = path.join(root, 'Documents')
  if (installed) await fs.mkdir(path.join(docs, 'OSSM Sauce', 'Paths'), { recursive: true })
  else await fs.mkdir(docs, { recursive: true })
  return docs
}

/** Defaults that keep a resolve hermetic: no real env, no `reg` spawn. */
function resolveOpts(over: OssmResolveOptions): OssmResolveOptions {
  return {
    env: {},
    home: null,
    configPath: path.join(testRoot, 'no-such-config.json'),
    lookupKnownFolder: async () => null,
    ...over,
  }
}

function target(dir: string | null, platform: string): OssmTarget {
  return { dir, source: 'detected', exists: true, platform }
}

/** Write a source file the way `videos/<id>/` holds it, and describe it. */
async function candidate(
  srcRoot: string,
  file: string,
  content: string,
  name = file,
): Promise<OssmCandidate> {
  const sourcePath = path.join(srcRoot, file)
  await fs.mkdir(srcRoot, { recursive: true })
  await fs.writeFile(sourcePath, content)
  return { videoId: 'vid', sourceFile: file, sourcePath, name }
}

describe('resolveOssmTarget — candidate preference', () => {
  test('prefers the Documents folder that already holds an install over a bare one', async () => {
    // The bug this exists to avoid: OneDrive holds the real install while a
    // plain %USERPROFILE%\Documents also exists and is empty.
    const root = await tmp()
    const oneDrive = path.join(root, 'OneDrive')
    const profile = path.join(root, 'profile')
    await makeDocuments(oneDrive, true)
    await makeDocuments(profile, false)

    const t = await resolveOssmTarget(
      resolveOpts({ platform: 'win32', env: { OneDrive: oneDrive, USERPROFILE: profile } }),
    )
    expect(t.dir).toBe(path.join(oneDrive, 'Documents', 'OSSM Sauce'))
    expect(t.source).toBe('detected')
    expect(t.exists).toBe(true)
  })

  test('picks the install even when it is behind the *last* candidate', async () => {
    const root = await tmp()
    const oneDrive = path.join(root, 'OneDrive')
    const profile = path.join(root, 'profile')
    await makeDocuments(oneDrive, false)
    await makeDocuments(profile, true)

    const t = await resolveOssmTarget(
      resolveOpts({ platform: 'win32', env: { OneDrive: oneDrive, USERPROFILE: profile } }),
    )
    expect(t.dir).toBe(path.join(profile, 'Documents', 'OSSM Sauce'))
    expect(t.source).toBe('detected')
  })

  test('UserSettings.cfg alone counts as an install (no Paths/ yet)', async () => {
    const root = await tmp()
    const ossm = path.join(root, 'Documents', 'OSSM Sauce')
    await fs.mkdir(ossm, { recursive: true })
    await fs.writeFile(path.join(ossm, 'UserSettings.cfg'), '[app_settings]\n')

    const t = await resolveOssmTarget(resolveOpts({ platform: 'darwin', home: root }))
    expect(t.dir).toBe(ossm)
    expect(t.source).toBe('detected')
    expect(t.exists).toBe(true)
  })

  test('with nothing installed, falls back to the first Documents that exists', async () => {
    const root = await tmp()
    const oneDrive = path.join(root, 'OneDrive')
    const profile = path.join(root, 'profile')
    await makeDocuments(oneDrive, false)
    await makeDocuments(profile, false)

    const t = await resolveOssmTarget(
      resolveOpts({ platform: 'win32', env: { OneDrive: oneDrive, USERPROFILE: profile } }),
    )
    expect(t.dir).toBe(path.join(oneDrive, 'Documents', 'OSSM Sauce'))
    expect(t.source).toBe('default')
    expect(t.exists).toBe(false)
  })

  test('on win32 the known-folder lookup outranks the env-var guesses when nothing is installed', async () => {
    const root = await tmp()
    const oneDrive = path.join(root, 'OneDrive')
    await makeDocuments(oneDrive, false)
    const redirected = await makeDocuments(path.join(root, 'redirected'), false)

    const t = await resolveOssmTarget(
      resolveOpts({
        platform: 'win32',
        env: { OneDrive: oneDrive },
        lookupKnownFolder: async () => redirected,
      }),
    )
    expect(t.dir).toBe(path.join(redirected, 'OSSM Sauce'))
    expect(t.source).toBe('default')
  })

  test('an install found only by the known-folder lookup resolves as detected', async () => {
    const root = await tmp()
    const oneDrive = path.join(root, 'OneDrive')
    await makeDocuments(oneDrive, false)
    const redirected = await makeDocuments(path.join(root, 'redirected'), true)

    const t = await resolveOssmTarget(
      resolveOpts({
        platform: 'win32',
        env: { OneDrive: oneDrive },
        lookupKnownFolder: async () => redirected,
      }),
    )
    expect(t.dir).toBe(path.join(redirected, 'OSSM Sauce'))
    expect(t.source).toBe('detected')
    expect(t.exists).toBe(true)
  })

  test('a failing known-folder lookup cannot fail the resolve', async () => {
    const root = await tmp()
    const oneDrive = await makeDocuments(path.join(root, 'OneDrive'), false)
    const t = await resolveOssmTarget(
      resolveOpts({
        platform: 'win32',
        env: { OneDrive: path.join(root, 'OneDrive') },
        lookupKnownFolder: async () => {
          throw new Error('reg not found')
        },
      }),
    )
    expect(t.dir).toBe(path.join(oneDrive, 'OSSM Sauce'))
    expect(t.source).toBe('default')
  })

  test('darwin uses ~/Documents', async () => {
    const root = await tmp()
    await makeDocuments(root, true)
    const t = await resolveOssmTarget(resolveOpts({ platform: 'darwin', home: root }))
    expect(t.dir).toBe(path.join(root, 'Documents', 'OSSM Sauce'))
    expect(t.source).toBe('detected')
  })

  test('linux honours $XDG_DOCUMENTS_DIR first', async () => {
    const root = await tmp()
    const xdg = path.join(root, 'Documenten')
    await fs.mkdir(path.join(xdg, 'OSSM Sauce', 'Paths'), { recursive: true })
    await makeDocuments(root, false)

    const t = await resolveOssmTarget(
      resolveOpts({ platform: 'linux', home: root, env: { XDG_DOCUMENTS_DIR: xdg } }),
    )
    expect(t.dir).toBe(path.join(xdg, 'OSSM Sauce'))
    expect(t.source).toBe('detected')
  })

  test('linux parses XDG_DOCUMENTS_DIR out of user-dirs.dirs, expanding $HOME', async () => {
    const root = await tmp()
    await fs.mkdir(path.join(root, '.config'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.config', 'user-dirs.dirs'),
      '# generated\nXDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOCUMENTS_DIR="$HOME/Dokumente"\n',
    )
    await fs.mkdir(path.join(root, 'Dokumente', 'OSSM Sauce', 'Paths'), { recursive: true })
    await makeDocuments(root, false)

    const t = await resolveOssmTarget(resolveOpts({ platform: 'linux', home: root }))
    expect(t.dir).toBe(path.join(root, 'Dokumente', 'OSSM Sauce'))
    expect(t.source).toBe('detected')
  })

  test('linux falls back to ~/Documents when there is no user-dirs.dirs', async () => {
    const root = await tmp()
    await makeDocuments(root, true)
    const t = await resolveOssmTarget(resolveOpts({ platform: 'linux', home: root }))
    expect(t.dir).toBe(path.join(root, 'Documents', 'OSSM Sauce'))
  })

  test('unresolved when there is no home dir and no env to go on', async () => {
    const t = await resolveOssmTarget(resolveOpts({ platform: 'linux', home: null }))
    expect(t.dir).toBeNull()
    expect(t.source).toBe('unresolved')
    expect(t.exists).toBe(false)
  })
})

describe('resolveOssmTarget — overrides', () => {
  test('OSSM_SAUCE_DIR pointing at the parent Documents folder', async () => {
    const root = await tmp()
    const docs = await makeDocuments(root, true)
    const t = await resolveOssmTarget(
      resolveOpts({ platform: 'win32', env: { OSSM_SAUCE_DIR: docs } }),
    )
    expect(t.dir).toBe(path.join(docs, 'OSSM Sauce'))
    expect(t.source).toBe('env')
    expect(t.exists).toBe(true)
  })

  test('OSSM_SAUCE_DIR pointing at the OSSM Sauce folder itself is not doubled', async () => {
    const root = await tmp()
    const docs = await makeDocuments(root, true)
    const inner = path.join(docs, 'OSSM Sauce')
    const t = await resolveOssmTarget(
      resolveOpts({ platform: 'win32', env: { OSSM_SAUCE_DIR: inner } }),
    )
    expect(t.dir).toBe(inner)
    expect(t.source).toBe('env')
  })

  test('config.json → ossmSauceDir, in both forms', async () => {
    const root = await tmp()
    const docs = await makeDocuments(root, true)
    const configPath = path.join(root, 'config.json')

    await fs.writeFile(configPath, JSON.stringify({ httpPort: 8000, ossmSauceDir: docs }))
    let t = await resolveOssmTarget(resolveOpts({ platform: 'win32', configPath }))
    expect(t.dir).toBe(path.join(docs, 'OSSM Sauce'))
    expect(t.source).toBe('config')

    await fs.writeFile(configPath, JSON.stringify({ ossmSauceDir: path.join(docs, 'OSSM Sauce') }))
    t = await resolveOssmTarget(resolveOpts({ platform: 'win32', configPath }))
    expect(t.dir).toBe(path.join(docs, 'OSSM Sauce'))
    expect(t.source).toBe('config')
  })

  test('env beats config, and an absent key falls through to detection', async () => {
    const root = await tmp()
    const fromEnv = path.join(root, 'env-dir')
    const configPath = path.join(root, 'config.json')
    await fs.writeFile(configPath, JSON.stringify({ ossmSauceDir: path.join(root, 'config-dir') }))

    let t = await resolveOssmTarget(
      resolveOpts({ platform: 'win32', configPath, env: { OSSM_SAUCE_DIR: fromEnv } }),
    )
    expect(t.dir).toBe(path.join(fromEnv, 'OSSM Sauce'))
    expect(t.source).toBe('env')

    // Same config file with the key gone: detection takes over.
    await fs.writeFile(configPath, JSON.stringify({ httpPort: 8000 }))
    const docs = await makeDocuments(root, true)
    t = await resolveOssmTarget(
      resolveOpts({ platform: 'win32', configPath, env: { USERPROFILE: root } }),
    )
    expect(t.dir).toBe(path.join(docs, 'OSSM Sauce'))
    expect(t.source).toBe('detected')
  })

  test('a malformed config.json does not break resolution', async () => {
    const root = await tmp()
    const configPath = path.join(root, 'config.json')
    await fs.writeFile(configPath, '{ not json')
    const docs = await makeDocuments(root, true)
    const t = await resolveOssmTarget(resolveOpts({ platform: 'darwin', home: root, configPath }))
    expect(t.dir).toBe(path.join(docs, 'OSSM Sauce'))
  })
})

describe('planFiles', () => {
  /** `<root>/Documents/OSSM Sauce` with `Paths/` present, plus a target for it. */
  async function installed(root: string): Promise<string> {
    return path.join(await makeDocuments(root, true), 'OSSM Sauce')
  }

  test('a name that is not in Paths/ is new', async () => {
    const root = await tmp()
    const ossm = await installed(root)
    const c = await candidate(path.join(root, 'src'), 'hope.bx', 'AAA')

    const [planned] = await planFiles(target(ossm, 'win32'), [c])
    expect(planned.status).toBe('new')
    expect(planned.name).toBe('hope.bx')
    expect(planned.bytes).toBe(3)
  })

  test('a byte-identical file already in Paths/ is identical', async () => {
    const root = await tmp()
    const ossm = await installed(root)
    await fs.writeFile(path.join(ossm, 'Paths', 'hope.bx'), 'AAA')
    const c = await candidate(path.join(root, 'src'), 'hope.bx', 'AAA')

    const [planned] = await planFiles(target(ossm, 'win32'), [c])
    expect(planned.status).toBe('identical')
    expect(planned.name).toBe('hope.bx')
  })

  test('same size but different bytes is not identical', async () => {
    const root = await tmp()
    const ossm = await installed(root)
    await fs.writeFile(path.join(ossm, 'Paths', 'hope.bx'), 'AAA')
    const c = await candidate(path.join(root, 'src'), 'hope.bx', 'BBB')

    const [planned] = await planFiles(target(ossm, 'win32'), [c])
    expect(planned.status).toBe('renamed')
    expect(planned.name).not.toBe('hope.bx')
  })

  test('a differing file is renamed with a hash suffix, deterministically', async () => {
    const root = await tmp()
    const ossm = await installed(root)
    await fs.writeFile(path.join(ossm, 'Paths', 'hope.bx'), 'existing content')
    const c = await candidate(path.join(root, 'src'), 'hope.bx', 'different content')

    const [a] = await planFiles(target(ossm, 'win32'), [c])
    const [b] = await planFiles(target(ossm, 'win32'), [c])
    expect(a.status).toBe('renamed')
    expect(a.name).toMatch(/^hope-[0-9a-f]{8}\.bx$/)
    expect(b.name).toBe(a.name)
  })

  test('keeps suffixing when the suffixed name is taken by something else too', async () => {
    const root = await tmp()
    const ossm = await installed(root)
    const c = await candidate(path.join(root, 'src'), 'hope.bx', 'mine')

    await fs.writeFile(path.join(ossm, 'Paths', 'hope.bx'), 'theirs')
    const [first] = await planFiles(target(ossm, 'win32'), [c])
    await fs.writeFile(path.join(ossm, 'Paths', first.name), 'theirs too')

    const [second] = await planFiles(target(ossm, 'win32'), [c])
    expect(second.status).toBe('renamed')
    expect(second.name).toMatch(/^hope-[0-9a-f]{8}-2\.bx$/)
  })

  test('two candidates in one batch cannot claim the same name', async () => {
    const root = await tmp()
    const ossm = await installed(root)
    const a = await candidate(path.join(root, 'src-a'), 'hope.bx', 'first')
    const b = await candidate(path.join(root, 'src-b'), 'hope.bx', 'second')

    const planned = await planFiles(target(ossm, 'win32'), [a, b])
    expect(planned[0].name).toBe('hope.bx')
    expect(planned[1].status).toBe('renamed')
    expect(planned[1].name).not.toBe('hope.bx')
  })

  test('creates and mutates nothing on disk', async () => {
    const root = await tmp()
    const docs = await makeDocuments(root, false)
    const c = await candidate(path.join(root, 'src'), 'hope.bx', 'AAA')

    await planFiles(target(path.join(docs, 'OSSM Sauce'), 'win32'), [c])
    expect(await fs.readdir(docs)).toEqual([])
  })

  test('an unresolved target plans everything as new', async () => {
    const root = await tmp()
    const c = await candidate(path.join(root, 'src'), 'hope.bx', 'AAA')
    const [planned] = await planFiles(target(null, 'win32'), [c])
    expect(planned.status).toBe('new')
  })

  test('a missing source file throws, naming the file', async () => {
    const root = await tmp()
    const c: OssmCandidate = {
      videoId: 'vid',
      sourceFile: 'gone.bx',
      sourcePath: path.join(root, 'src', 'gone.bx'),
      name: 'gone.bx',
    }
    expect(planFiles(target(root, 'win32'), [c])).rejects.toThrow(/gone\.bx/)
  })

  test('rejects a name that is not a bare filename', async () => {
    const root = await tmp()
    const c = await candidate(path.join(root, 'src'), 'hope.bx', 'AAA', '../escape.bx')
    expect(planFiles(target(root, 'win32'), [c])).rejects.toThrow(/Invalid OSSM path filename/)
  })
})

describe('planFiles — case folding per platform', () => {
  /**
   * One fixture, three platforms: `Hard.bx` on disk against a `hard.bx`
   * candidate with different content.
   */
  let ossm = ''
  let c: OssmCandidate

  beforeAll(async () => {
    const root = await tmp()
    ossm = path.join(root, 'Documents', 'OSSM Sauce')
    await fs.mkdir(path.join(ossm, 'Paths'), { recursive: true })
    await fs.writeFile(path.join(ossm, 'Paths', 'Hard.bx'), 'capital H content')
    c = await candidate(path.join(root, 'src'), 'hard.bx', 'lowercase h content')
  })

  test('win32: hard.bx collides with Hard.bx', async () => {
    expect((await planFiles(target(ossm, 'win32'), [c]))[0].status).toBe('renamed')
  })

  test('darwin: hard.bx collides with Hard.bx', async () => {
    const [planned] = await planFiles(target(ossm, 'darwin'), [c])
    expect(planned.status).toBe('renamed')
    expect(planned.name).toMatch(/^hard-[0-9a-f]{8}\.bx$/)
  })

  test('linux: hard.bx and Hard.bx are two different files', async () => {
    const [planned] = await planFiles(target(ossm, 'linux'), [c])
    expect(planned.status).toBe('new')
    expect(planned.name).toBe('hard.bx')
  })

  test('an identical match reports the casing that is on disk', async () => {
    const root = await tmp()
    const dir = path.join(root, 'OSSM Sauce')
    await fs.mkdir(path.join(dir, 'Paths'), { recursive: true })
    await fs.writeFile(path.join(dir, 'Paths', 'Hope.bx'), 'AAA')
    const same = await candidate(path.join(root, 'src'), 'hope.bx', 'AAA')

    const [planned] = await planFiles(target(dir, 'darwin'), [same])
    expect(planned.status).toBe('identical')
    expect(planned.name).toBe('Hope.bx')
  })
})

describe('installFiles', () => {
  test('creates both folders, copies new files and skips identical ones', async () => {
    const root = await tmp()
    const ossm = path.join(root, 'Documents', 'OSSM Sauce')
    await fs.mkdir(path.join(ossm, 'Paths'), { recursive: true })
    await fs.writeFile(path.join(ossm, 'Paths', 'old.bx'), 'same')

    const src = path.join(root, 'src')
    const cNew = await candidate(src, 'new.bx', 'fresh')
    const cSame = await candidate(src, 'old.bx', 'same')
    const t = target(ossm, 'win32')
    const planned = await planFiles(t, [cNew, cSame])

    const result = await installFiles(t, planned, {
      name: 'My List',
      lines: planned.map((p) => p.name),
    })

    expect(result.dir).toBe(ossm)
    expect(result.written).toEqual(['new.bx'])
    expect(result.skipped).toEqual(['old.bx'])
    expect(result.warnings).toEqual([])
    expect(await fs.readFile(path.join(ossm, 'Paths', 'new.bx'), 'utf8')).toBe('fresh')
    expect(result.playlist).toBe('My List.bxpl')
    // LF-terminated, one bare filename per line — the app's legacy v1 shape,
    // which `_parse_legacy` still reads.
    expect(await fs.readFile(path.join(ossm, 'Playlists', 'My List.bxpl'), 'utf8')).toBe(
      'new.bx\nold.bx\n',
    )
  })

  test('a renamed file is written under the new name and the original is untouched', async () => {
    const root = await tmp()
    const ossm = path.join(root, 'Documents', 'OSSM Sauce')
    await fs.mkdir(path.join(ossm, 'Paths'), { recursive: true })
    await fs.writeFile(path.join(ossm, 'Paths', 'hope.bx'), 'theirs')
    const c = await candidate(path.join(root, 'src'), 'hope.bx', 'mine')

    const t = target(ossm, 'win32')
    const planned = await planFiles(t, [c])
    const result = await installFiles(t, planned, null)

    expect(result.written).toEqual([planned[0].name])
    expect(await fs.readFile(path.join(ossm, 'Paths', 'hope.bx'), 'utf8')).toBe('theirs')
    expect(await fs.readFile(path.join(ossm, 'Paths', planned[0].name), 'utf8')).toBe('mine')
    expect(result.playlist).toBeNull()
    // Playlists/ is created even for a paths-only export.
    expect(await fs.readdir(path.join(ossm, 'Playlists'))).toEqual([])
  })

  test('never clobbers an existing .bxpl — writes "(2)" and warns', async () => {
    const root = await tmp()
    const ossm = path.join(root, 'Documents', 'OSSM Sauce')
    await fs.mkdir(path.join(ossm, 'Playlists'), { recursive: true })
    await fs.writeFile(path.join(ossm, 'Playlists', 'My List.bxpl'), 'theirs.bx\n')

    const t = target(ossm, 'win32')
    let result = await installFiles(t, [], { name: 'My List', lines: ['a.bx'] })
    expect(result.playlist).toBe('My List (2).bxpl')
    expect(result.warnings.join(' ')).toMatch(/already in Playlists/)
    expect(await fs.readFile(path.join(ossm, 'Playlists', 'My List.bxpl'), 'utf8')).toBe(
      'theirs.bx\n',
    )

    result = await installFiles(t, [], { name: 'My List', lines: ['b.bx'] })
    expect(result.playlist).toBe('My List (3).bxpl')
  })

  test('re-installing the same playlist is a no-op, not a "(2)" copy', async () => {
    const root = await tmp()
    const ossm = path.join(root, 'OSSM Sauce')
    const t = target(ossm, 'win32')
    const playlist = { name: 'My List', lines: ['a.bx', 'b.bx'] }

    const first = await installFiles(t, [], playlist)
    const second = await installFiles(t, [], playlist)

    expect(first.playlist).toBe('My List.bxpl')
    expect(second.playlist).toBe('My List.bxpl')
    expect(second.warnings).toEqual([])
    expect(await fs.readdir(path.join(ossm, 'Playlists'))).toEqual(['My List.bxpl'])
  })

  test('a playlist name that already ends in .bxpl is not doubled', async () => {
    const root = await tmp()
    const ossm = path.join(root, 'OSSM Sauce')
    const result = await installFiles(target(ossm, 'win32'), [], {
      name: 'My List.bxpl',
      lines: ['a.bx'],
    })
    expect(result.playlist).toBe('My List.bxpl')
    expect(await fs.readdir(path.join(ossm, 'Playlists'))).toEqual(['My List.bxpl'])
  })

  test('throws when the target could not be resolved', async () => {
    expect(installFiles(target(null, 'win32'), [], null)).rejects.toThrow(/OSSM_SAUCE_DIR/)
  })
})

describe('queryWindowsDocuments', () => {
  // Read-only, and the only thing that can prove the parser matches real `reg`
  // output. Skipped off Windows, where there is no registry to read.
  test.if(process.platform === 'win32')(
    'returns an absolute, fully expanded path from real reg output',
    async () => {
      const dir = await queryWindowsDocuments(process.env, os.homedir())
      expect(dir).toBeTruthy()
      expect(path.isAbsolute(dir as string)).toBe(true)
      expect(dir).not.toContain('%')
    },
  )
})
