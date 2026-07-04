import { app } from 'electron'
import { promises as fsp } from 'fs'
import { basename, extname, join } from 'path'
import type { PresetInfo } from '../shared/types'

// User-imported Butterchurn presets: plain .json files in userData/presets.
// Ids are 'u:<filename-without-ext>' (bundled presets use 'b:<name>' and
// never touch the main process). Raw .milk conversion is phase 2.

function userPresetsDir(): string {
  return join(app.getPath('userData'), 'presets')
}

function looksLikeButterchurnPreset(obj: unknown): boolean {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'baseVals' in obj &&
    typeof (obj as { baseVals: unknown }).baseVals === 'object'
  )
}

export async function listUserPresets(): Promise<PresetInfo[]> {
  let files: string[]
  try {
    files = await fsp.readdir(userPresetsDir())
  } catch {
    return []
  }
  return files
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .map((f) => {
      const name = basename(f, extname(f))
      return { id: `u:${name}`, name, source: 'user' as const }
    })
}

export async function readUserPreset(id: string): Promise<object> {
  if (!id.startsWith('u:')) throw new Error(`not a user preset id: ${id}`)
  const name = id.slice(2)
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error('invalid preset name')
  }
  const raw = await fsp.readFile(join(userPresetsDir(), `${name}.json`), 'utf8')
  const obj = JSON.parse(raw) as unknown
  if (!looksLikeButterchurnPreset(obj)) throw new Error('not a Butterchurn preset')
  return obj as object
}

export async function importPresetFiles(paths: string[]): Promise<PresetInfo[]> {
  await fsp.mkdir(userPresetsDir(), { recursive: true })
  const imported: PresetInfo[] = []
  for (const p of paths) {
    const ext = extname(p).toLowerCase()
    if (ext === '.milk') {
      console.warn(`skipping ${p}: raw .milk conversion is not supported yet — import converted .json presets`)
      continue
    }
    if (ext !== '.json') continue
    try {
      const raw = await fsp.readFile(p, 'utf8')
      const obj = JSON.parse(raw) as unknown
      if (!looksLikeButterchurnPreset(obj)) {
        console.warn(`skipping ${p}: does not look like a Butterchurn preset`)
        continue
      }
      const name = basename(p, extname(p)).replace(/[<>:"/\\|?*]/g, '_')
      await fsp.writeFile(join(userPresetsDir(), `${name}.json`), raw, 'utf8')
      imported.push({ id: `u:${name}`, name, source: 'user' })
    } catch (err) {
      console.warn(`failed to import preset ${p}:`, err)
    }
  }
  return imported
}
