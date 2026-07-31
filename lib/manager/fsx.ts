import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** `Path.exists()` — any stat failure counts as "not there". */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/** `Path.is_dir()`. */
export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Unlike `@/lib/json`'s forgiving `readJson`, this throws, because several
 * endpoints report the parse error back to the client.
 */
export async function readJsonStrict<T = unknown>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T
}

/** `shutil.rmtree`, never throwing. */
export async function rmrf(p: string): Promise<void> {
  try {
    await fs.rm(p, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/**
 * Scratch directory for streamed uploads/extractions.
 *
 * Deliberately created *inside* the destination tree rather than in the OS temp
 * dir: the repo lives on a different volume than %TEMP%, so a temp-then-move
 * there would silently degrade every `rename` into a full byte-for-byte copy of
 * a multi-GB upload. Same-volume means `fs.rename` is a metadata op.
 */
export async function makeTempDir(nearBase: string, prefix = '.tmp-'): Promise<string> {
  await fs.mkdir(nearBase, { recursive: true })
  const dir = path.join(nearBase, prefix + crypto.randomBytes(8).toString('hex'))
  await fs.mkdir(dir, { recursive: false })
  return dir
}

/**
 * `shutil.move` — a plain rename, since every temp dir we create already lives
 * on the destination volume. The EXDEV fallback only fires if that invariant is
 * ever broken.
 */
export async function moveInto(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await fs.copyFile(src, dest)
    await fs.unlink(src)
  }
}

/**
 * All files below `dir` as POSIX-style relative paths, sorted. Directories
 * with no files in them are dropped.
 */
export async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(current: string, rel: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(path.join(current, e.name), childRel)
      else if (e.isFile()) out.push(childRel)
    }
  }
  await walk(dir, '')
  out.sort()
  return out
}

/**
 * Directory entry names sorted the way `sorted(folder.iterdir())` sorts them on
 * Windows, where `PurePath` compares case-folded.
 */
export async function sortedDirNames(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir)
    return names.sort((a, b) => {
      const la = a.toLowerCase()
      const lb = b.toLowerCase()
      return la < lb ? -1 : la > lb ? 1 : 0
    })
  } catch {
    return []
  }
}

/** Round to 3 decimal places — the precision durations are stored at. */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
