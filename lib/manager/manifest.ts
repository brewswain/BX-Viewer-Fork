import fs from 'node:fs/promises'
import { PLAYLIST_BASE, PLAYLIST_MANIFEST, VIDEO_BASE, VIDEO_MANIFEST } from '@/lib/paths'
import { writeJson } from '@/lib/json'
import { pathExists, readJsonStrict } from './fsx'

export type Section = 'videos' | 'playlists'

/** manager.py: `base = VIDEO_BASE if section == "videos" else PLAYLIST_BASE`. */
export function baseFor(section: Section): string {
  return section === 'videos' ? VIDEO_BASE : PLAYLIST_BASE
}

export function manifestFor(section: Section): string {
  return section === 'videos' ? VIDEO_MANIFEST : PLAYLIST_MANIFEST
}

export async function manifestExists(section: Section): Promise<boolean> {
  return pathExists(manifestFor(section))
}

/** Throws if the manifest is missing or malformed — callers map that to 404/500. */
export async function readManifest(section: Section): Promise<string[]> {
  const data = await readJsonStrict<unknown>(manifestFor(section))
  return Array.isArray(data) ? (data as string[]) : []
}

export async function writeManifest(section: Section, ids: string[]): Promise<void> {
  await writeJson(manifestFor(section), ids)
}

/**
 * Load the manifest, tolerating absence the way create/import do: the section
 * directory is created and an empty list is assumed.
 */
export async function readManifestOrCreate(section: Section): Promise<string[]> {
  if (await manifestExists(section)) return readManifest(section)
  await fs.mkdir(baseFor(section), { recursive: true })
  return []
}
