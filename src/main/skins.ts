import { app, shell } from 'electron'
import { promises as fsp } from 'fs'
import { join, normalize, resolve, sep } from 'path'
import type { SkinInfo } from '../shared/types'

const SKIN_API_VERSION = 1
const SAFE_ID = /^[a-z0-9-]+$/

function bundledSkinsDir(): string {
  // Packaged: <resources>/skins (electron-builder extraResources).
  // Dev: <repo>/skins.
  return app.isPackaged ? join(process.resourcesPath, 'skins') : join(app.getAppPath(), 'skins')
}

export function userSkinsDir(): string {
  return join(app.getPath('userData'), 'skins')
}

interface RawManifest {
  id?: unknown
  name?: unknown
  author?: unknown
  version?: unknown
  apiVersion?: unknown
  entry?: unknown
  window?: {
    width?: unknown
    height?: unknown
    minWidth?: unknown
    minHeight?: unknown
    resizable?: unknown
  }
  features?: unknown
}

function validateManifest(raw: RawManifest, folderName: string, source: 'bundled' | 'user'): SkinInfo | string {
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!SAFE_ID.test(id)) return `invalid id "${id}"`
  if (id !== folderName) return `id "${id}" must match folder name "${folderName}"`
  if (source === 'user' && id === 'default') return `user skins may not use the reserved id "default"`
  if (raw.apiVersion !== SKIN_API_VERSION) return `unsupported apiVersion ${raw.apiVersion}`
  const entry = typeof raw.entry === 'string' ? raw.entry : 'index.html'
  if (entry.includes('..')) return 'entry must be a relative file inside the skin folder'
  const w = raw.window ?? {}
  const num = (v: unknown, d: number): number => (typeof v === 'number' && v > 0 ? v : d)
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : id,
    author: typeof raw.author === 'string' ? raw.author : '',
    version: typeof raw.version === 'string' ? raw.version : '0.0.0',
    apiVersion: SKIN_API_VERSION,
    entry,
    window: {
      width: num(w.width, 640),
      height: num(w.height, 440),
      minWidth: num(w.minWidth, 320),
      minHeight: num(w.minHeight, 240),
      resizable: w.resizable !== false
    },
    features: Array.isArray(raw.features) ? raw.features.filter((f) => typeof f === 'string') : [],
    source
  }
}

async function scanDir(dir: string, source: 'bundled' | 'user'): Promise<SkinInfo[]> {
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return []
  }
  const skins: SkinInfo[] = []
  for (const folder of entries) {
    const manifestPath = join(dir, folder, 'skin.json')
    try {
      const raw = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as RawManifest
      const result = validateManifest(raw, folder, source)
      if (typeof result === 'string') {
        console.warn(`skipping skin "${folder}": ${result}`)
      } else {
        skins.push(result)
      }
    } catch {
      // no manifest / bad JSON — not a skin folder
    }
  }
  return skins
}

export async function listSkins(): Promise<SkinInfo[]> {
  const bundled = await scanDir(bundledSkinsDir(), 'bundled')
  const user = await scanDir(userSkinsDir(), 'user')
  const seen = new Set(bundled.map((s) => s.id))
  const merged = [...bundled]
  for (const s of user) {
    if (seen.has(s.id)) console.warn(`user skin "${s.id}" shadows a bundled skin — skipped`)
    else merged.push(s)
  }
  return merged
}

/** Absolute root folder of a skin, or null if unknown. */
export async function skinRoot(id: string): Promise<string | null> {
  const all = await listSkins()
  const skin = all.find((s) => s.id === id)
  if (!skin) return null
  return join(skin.source === 'bundled' ? bundledSkinsDir() : userSkinsDir(), id)
}

export async function readSkinEntry(id: string): Promise<{ html: string; baseUrl: string }> {
  const root = await skinRoot(id)
  if (!root) throw new Error(`unknown skin: ${id}`)
  const all = await listSkins()
  const skin = all.find((s) => s.id === id)!
  const html = await fsp.readFile(join(root, skin.entry), 'utf8')
  return { html, baseUrl: `ampwin://skin/${id}/` }
}

/** Serve a skin asset, path-jailed to the skin's folder. */
export async function resolveSkinAsset(id: string, relPath: string): Promise<string | null> {
  if (!SAFE_ID.test(id)) return null
  const root = await skinRoot(id)
  if (!root) return null
  const abs = resolve(root, normalize(relPath))
  if (abs !== root && !abs.startsWith(root + sep)) return null // jail escape attempt
  return abs
}

export async function openUserSkinsFolder(): Promise<void> {
  await fsp.mkdir(userSkinsDir(), { recursive: true })
  await shell.openPath(userSkinsDir())
}
