// Addon manager. Addons are folders (addon.json manifest + JS) installed to
// userData/addons/<id>/ from a GitHub repo. The repo has a root index.json
// listing available addons and the files to fetch. Installed + enabled addons
// are loaded by the renderer into hidden iframes with the full window.ampwin
// API (see renderer/addon/addonHost.ts). This module only handles discovery,
// download, and on-disk state — it never executes addon code.

import { app, net, shell } from 'electron'
import { createWriteStream, promises as fsp } from 'fs'
import { join, normalize, resolve, sep } from 'path'
import type { AddonCatalogEntry, AddonInfo } from '../shared/types'
import { getSettings, patchSettings } from './store/settings'

const ADDON_API_VERSION = 1
const SAFE_ID = /^[a-z0-9-]+$/

export function addonsDir(): string {
  return join(app.getPath('userData'), 'addons')
}

function addonRoot(id: string): string {
  return join(addonsDir(), id)
}

// ---- repo URL → raw content base -------------------------------------------

/** https://github.com/OWNER/REPO → https://raw.githubusercontent.com/OWNER/REPO/<branch> */
function rawBaseFor(repoUrl: string, branch: string): string {
  const m = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repoUrl.trim())
  if (!m) throw new Error(`not a GitHub repo URL: ${repoUrl}`)
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${branch}`
}

async function repoBranchBase(): Promise<string> {
  const { addonRepoUrl } = await getSettings()
  // Try the modern default branch first, then the legacy one.
  for (const branch of ['main', 'master']) {
    const base = rawBaseFor(addonRepoUrl, branch)
    try {
      const res = await net.fetch(`${base}/index.json`, { method: 'HEAD', cache: 'no-store' })
      if (res.ok) return base
    } catch {
      /* try next branch */
    }
  }
  // Fall back to main; the caller's fetch will surface a clear error if wrong.
  return rawBaseFor(addonRepoUrl, 'main')
}

// ---- catalog ---------------------------------------------------------------

function validCatalogEntry(raw: unknown): AddonCatalogEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id : ''
  if (!SAFE_ID.test(id)) return null
  const files = Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === 'string') : []
  if (files.length === 0) return null
  // Reject any path that would escape the addon folder.
  if (files.some((f) => f.includes('..') || f.startsWith('/') || f.includes('\\'))) return null
  return {
    id,
    name: typeof r.name === 'string' ? r.name : id,
    version: typeof r.version === 'string' ? r.version : '0.0.0',
    description: typeof r.description === 'string' ? r.description : '',
    author: typeof r.author === 'string' ? r.author : '',
    entry: typeof r.entry === 'string' ? r.entry : 'main.js',
    files
  }
}

/** Fetch and parse the repo's index.json. Throws on network/parse failure.
 *  cache:'no-store' — raw.githubusercontent serves 5-minute cache headers and
 *  Electron honors them; a freshly pushed addon must show up on ↻ immediately. */
export async function fetchCatalog(): Promise<AddonCatalogEntry[]> {
  const base = await repoBranchBase()
  const res = await net.fetch(`${base}/index.json`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`could not read the addon repo index (HTTP ${res.status})`)
  const json = (await res.json()) as unknown
  const rawList = Array.isArray(json)
    ? json
    : typeof json === 'object' && json !== null && Array.isArray((json as { addons?: unknown }).addons)
      ? (json as { addons: unknown[] }).addons
      : []
  return rawList.map(validCatalogEntry).filter((e): e is AddonCatalogEntry => e !== null)
}

// ---- installed state -------------------------------------------------------

interface RawManifest {
  apiVersion?: unknown
  id?: unknown
  name?: unknown
  version?: unknown
  description?: unknown
  author?: unknown
  entry?: unknown
}

async function readManifest(id: string): Promise<AddonInfo | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(join(addonRoot(id), 'addon.json'), 'utf8')) as RawManifest
    if (raw.apiVersion !== ADDON_API_VERSION) return null
    if (raw.id !== id) return null
    const entry = typeof raw.entry === 'string' ? raw.entry : 'main.js'
    if (entry.includes('..') || entry.includes('\\') || entry.startsWith('/')) return null
    return {
      id,
      name: typeof raw.name === 'string' ? raw.name : id,
      version: typeof raw.version === 'string' ? raw.version : '0.0.0',
      description: typeof raw.description === 'string' ? raw.description : '',
      author: typeof raw.author === 'string' ? raw.author : '',
      entry,
      installed: true,
      enabled: false
    }
  } catch {
    return null
  }
}

async function scanInstalled(): Promise<Map<string, AddonInfo>> {
  const map = new Map<string, AddonInfo>()
  let entries: string[]
  try {
    entries = await fsp.readdir(addonsDir())
  } catch {
    return map
  }
  const { enabledAddonIds } = await getSettings()
  for (const folder of entries) {
    if (!SAFE_ID.test(folder)) continue
    const info = await readManifest(folder)
    if (info) {
      info.enabled = enabledAddonIds.includes(folder)
      map.set(folder, info)
    }
  }
  return map
}

/** Installed addons only (no network) — used by the boot loader. */
export async function listInstalled(): Promise<AddonInfo[]> {
  return [...(await scanInstalled()).values()]
}

/** Installed enabled addons, for the renderer to load at boot. */
export async function listEnabled(): Promise<AddonInfo[]> {
  return (await listInstalled()).filter((a) => a.enabled)
}

/** Merged catalog + installed for the Addons browser. Falls back to
 *  installed-only if the repo can't be reached. */
export async function browseAddons(): Promise<{ addons: AddonInfo[]; catalogError?: string }> {
  const installed = await scanInstalled()
  let catalog: AddonCatalogEntry[] = []
  let catalogError: string | undefined
  try {
    catalog = await fetchCatalog()
  } catch (err) {
    catalogError = (err as Error).message
  }

  const merged = new Map<string, AddonInfo>()
  for (const c of catalog) {
    const inst = installed.get(c.id)
    merged.set(c.id, {
      id: c.id,
      name: c.name,
      version: c.version,
      description: c.description,
      author: c.author,
      entry: c.entry ?? 'main.js',
      installed: !!inst,
      enabled: inst?.enabled ?? false,
      updateAvailable: !!inst && inst.version !== c.version
    })
  }
  // Installed addons not present in the catalog still show up.
  for (const [id, inst] of installed) {
    if (!merged.has(id)) merged.set(id, inst)
  }
  return { addons: [...merged.values()], catalogError }
}

// ---- install / uninstall / enable ------------------------------------------

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await net.fetch(url, { cache: 'no-store' })
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status}) for ${url}`)
  const tmp = `${dest}.part`
  const out = createWriteStream(tmp)
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((r) => out.once('drain', r))
      }
    }
    await new Promise<void>((resolve2, reject) => out.end((e?: Error) => (e ? reject(e) : resolve2())))
  } catch (err) {
    out.destroy()
    await fsp.unlink(tmp).catch(() => {})
    throw err
  }
  await fsp.rename(tmp, dest)
}

/** Download an addon into userData/addons/<id>/ (atomic: staged then swapped in). */
export async function installAddon(
  id: string,
  onProgress?: (percent: number) => void
): Promise<AddonInfo> {
  if (!SAFE_ID.test(id)) throw new Error(`invalid addon id: ${id}`)
  const catalog = await fetchCatalog()
  const entry = catalog.find((c) => c.id === id)
  if (!entry) throw new Error(`addon "${id}" is not in the repo index`)

  const base = await repoBranchBase()
  const staging = join(addonsDir(), `.staging-${id}`)
  await fsp.rm(staging, { recursive: true, force: true })
  await fsp.mkdir(staging, { recursive: true })

  try {
    for (let i = 0; i < entry.files.length; i++) {
      const rel = entry.files[i]
      const dest = join(staging, normalize(rel))
      if (dest !== staging && !dest.startsWith(staging + sep)) throw new Error(`bad file path: ${rel}`)
      await fsp.mkdir(join(dest, '..'), { recursive: true })
      await downloadTo(`${base}/${id}/${rel}`, dest)
      onProgress?.(Math.round(((i + 1) / entry.files.length) * 100))
    }
    // Must contain a valid addon.json matching the id.
    const manifestRaw = JSON.parse(await fsp.readFile(join(staging, 'addon.json'), 'utf8')) as RawManifest
    if (manifestRaw.apiVersion !== ADDON_API_VERSION || manifestRaw.id !== id) {
      throw new Error('downloaded addon has an invalid manifest')
    }

    // Swap staging → final atomically.
    const finalDir = addonRoot(id)
    await fsp.rm(finalDir, { recursive: true, force: true })
    await fsp.rename(staging, finalDir)
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
    throw err
  }

  const info = await readManifest(id)
  if (!info) throw new Error('addon installed but its manifest could not be read')
  onProgress?.(100)
  return info
}

export async function uninstallAddon(id: string): Promise<void> {
  if (!SAFE_ID.test(id)) return
  await setAddonEnabled(id, false)
  await fsp.rm(addonRoot(id), { recursive: true, force: true })
}

export async function setAddonEnabled(id: string, enabled: boolean): Promise<void> {
  if (!SAFE_ID.test(id)) return
  const { enabledAddonIds } = await getSettings()
  const set = new Set(enabledAddonIds)
  if (enabled) set.add(id)
  else set.delete(id)
  await patchSettings({ enabledAddonIds: [...set] })
}

// ---- asset serving (protocol) ----------------------------------------------

/** Absolute path for an addon asset, path-jailed to the addon folder. */
export async function resolveAddonAsset(id: string, relPath: string): Promise<string | null> {
  if (!SAFE_ID.test(id)) return null
  const root = addonRoot(id)
  const abs = resolve(root, normalize(relPath))
  if (abs !== root && !abs.startsWith(root + sep)) return null
  try {
    await fsp.access(abs)
  } catch {
    return null
  }
  return abs
}

export async function openAddonsFolder(): Promise<void> {
  await fsp.mkdir(addonsDir(), { recursive: true })
  await shell.openPath(addonsDir())
}
