import { app } from 'electron'
import { join } from 'path'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/types'
import { readJson, writeJsonAtomic } from './jsonFile'

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

let cache: Settings | null = null

export async function getSettings(): Promise<Settings> {
  if (!cache) {
    const stored = await readJson<Partial<Settings>>(settingsPath(), {})
    // Migration: the pre-video default cap (1 GB) would thrash multi-GB video
    // conversions out of the cache — treat it as "unset" and take the new default.
    if (stored.cacheMaxBytes === 1024 * 1024 * 1024) delete stored.cacheMaxBytes
    cache = { ...DEFAULT_SETTINGS, ...stored }
  }
  return cache
}

export async function patchSettings(partial: Partial<Settings>): Promise<Settings> {
  const current = await getSettings()
  cache = { ...current, ...partial }
  await writeJsonAtomic(settingsPath(), cache)
  return cache
}
