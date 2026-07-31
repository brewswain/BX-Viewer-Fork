import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { writeJson } from '@/lib/json'
import { VIDEO_BASE, isValidId } from '@/lib/paths'
import { isDirectory, pathExists, readJsonStrict, round3, sortedDirNames } from './fsx'

const execFileAsync = promisify(execFile)

const VIDEO_EXTS = ['.mp4', '.webm', '.mkv', '.mov']

type Meta = Record<string, unknown>

function asObject(value: unknown): Meta | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Meta) : null
}

/** `shutil.which('ffprobe')`, resolved once per process. */
let ffprobeResolved: string | null | undefined
async function whichFfprobe(): Promise<string | null> {
  if (ffprobeResolved !== undefined) return ffprobeResolved
  const exts =
    process.platform === 'win32'
      ? [...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean), '']
      : ['']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, 'ffprobe' + ext)
      if (await pathExists(candidate)) {
        ffprobeResolved = candidate
        return candidate
      }
    }
  }
  ffprobeResolved = null
  return null
}

/** Locate the playable file the way manager.py guesses when meta is silent. */
async function guessVideoFile(folderId: string, folder: string): Promise<string | null> {
  for (const ext of VIDEO_EXTS) {
    if (await pathExists(path.join(folder, folderId + ext))) return folderId + ext
  }
  if (await isDirectory(folder)) {
    for (const name of await sortedDirNames(folder)) {
      if (VIDEO_EXTS.includes(path.extname(name).toLowerCase())) return name
    }
  }
  return null
}

async function entryDuration(entry: unknown, ffprobe: string | null): Promise<number | null> {
  let folderId = ''
  if (typeof entry === 'string') {
    folderId = entry
  } else {
    const obj = asObject(entry)
    const id = obj?.id ?? obj?.videoId
    folderId = typeof id === 'string' ? id : ''
  }
  // manager.py `continue`d on a blank id — no duration, no warning.
  if (!folderId) return null
  if (!isValidId(folderId)) return null

  const folder = path.join(VIDEO_BASE, folderId)
  const metaPath = path.join(folder, 'meta.json')

  let vmeta: Meta = {}
  let videoDur: number | null = null

  // 1. meta.json: durationSecs wins, else `duration` in 60 fps frames.
  try {
    const parsed = asObject(await readJsonStrict(metaPath))
    if (!parsed) throw new Error('meta.json is not an object')
    vmeta = parsed
    if (vmeta.durationSecs !== undefined && vmeta.durationSecs !== null) {
      const n = Number(vmeta.durationSecs)
      if (!Number.isFinite(n)) throw new Error('durationSecs is not a number')
      videoDur = n
    } else if (vmeta.duration !== undefined && vmeta.duration !== null) {
      const n = Number(vmeta.duration)
      if (!Number.isFinite(n)) throw new Error('duration is not a number')
      videoDur = n / 60
    }
  } catch {
    // Matches the Python: a bad meta.json resets the dict, so the ffprobe
    // fallback below has to re-guess the video file from the folder.
    vmeta = {}
    videoDur = null
  }

  // 2. Fall back to probing the media itself.
  if (videoDur === null && ffprobe) {
    let videoFile = typeof vmeta.videoFile === 'string' ? vmeta.videoFile : null
    if (!videoFile) videoFile = await guessVideoFile(folderId, folder)

    if (videoFile) {
      const videoPath = path.join(folder, videoFile)
      if (await pathExists(videoPath)) {
        try {
          const { stdout } = await execFileAsync(
            ffprobe,
            ['-v', 'quiet', '-print_format', 'json', '-show_format', videoPath],
            { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
          )
          const probe = asObject(JSON.parse(stdout))
          const dur = Number(asObject(probe?.format)?.duration ?? 0)
          if (dur > 0) {
            videoDur = dur
            // Persist so future saves skip the probe entirely.
            try {
              vmeta.durationSecs = round3(dur)
              await writeJson(metaPath, vmeta)
            } catch {
              /* best effort */
            }
          }
        } catch {
          /* unprobeable — treated as unknown, same as the Python */
        }
      }
    }
  }

  if (videoDur === null) {
    console.warn(`[tally] Warning: no duration found for video "${folderId}"`)
  }
  return videoDur
}

/**
 * manager.py `_tally_playlist_duration`. The per-entry probes run concurrently
 * — the Python did them one at a time, which made saving a long playlist of
 * unprobed videos take seconds per entry.
 */
export async function tallyPlaylistDuration(videos: unknown): Promise<number> {
  const list = Array.isArray(videos) ? videos : []
  if (list.length === 0) return 0

  const ffprobe = await whichFfprobe()
  const durations = await Promise.all(list.map((entry) => entryDuration(entry, ffprobe)))

  let total = 0
  for (const d of durations) if (d !== null) total += d
  return total
}
