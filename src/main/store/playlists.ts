import { app } from 'electron'
import { promises as fsp, writeFileSync } from 'fs'
import { join } from 'path'
import type { Playlist, PlaylistMeta, SessionState } from '../../shared/types'
import { readJson, writeJsonAtomic } from './jsonFile'

function playlistsDir(): string {
  return join(app.getPath('userData'), 'playlists')
}

function sessionPath(): string {
  return join(app.getPath('userData'), 'session.json')
}

const SAFE_ID = /^[a-zA-Z0-9_-]+$/

function fileFor(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`invalid playlist id: ${id}`)
  return join(playlistsDir(), `${id}.json`)
}

export async function listPlaylists(): Promise<PlaylistMeta[]> {
  let files: string[]
  try {
    files = await fsp.readdir(playlistsDir())
  } catch {
    return []
  }
  const metas: PlaylistMeta[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const pl = await readJson<Playlist | null>(join(playlistsDir(), f), null)
    if (pl && pl.id && Array.isArray(pl.tracks)) {
      metas.push({ id: pl.id, name: pl.name, trackCount: pl.tracks.length, updatedAt: pl.updatedAt })
    }
  }
  metas.sort((a, b) => b.updatedAt - a.updatedAt)
  return metas
}

export async function getPlaylist(id: string): Promise<Playlist> {
  const pl = await readJson<Playlist | null>(fileFor(id), null)
  if (!pl) throw new Error(`playlist not found: ${id}`)
  return pl
}

export async function savePlaylist(pl: Playlist): Promise<void> {
  await writeJsonAtomic(fileFor(pl.id), pl)
}

export async function deletePlaylist(id: string): Promise<void> {
  await fsp.unlink(fileFor(id)).catch(() => {})
}

export async function getSession(): Promise<SessionState | null> {
  return readJson<SessionState | null>(sessionPath(), null)
}

export async function saveSession(state: SessionState): Promise<void> {
  await writeJsonAtomic(sessionPath(), state)
}

/** Synchronous flush for the beforeunload/quit path — an async write can be
 *  cut off before the process exits, losing the last changes. */
export function saveSessionSync(state: SessionState): void {
  try {
    writeFileSync(sessionPath(), JSON.stringify(state, null, 2), 'utf8')
  } catch (err) {
    console.error('session flush failed', err)
  }
}
