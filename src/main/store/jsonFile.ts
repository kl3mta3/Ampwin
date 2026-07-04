import { promises as fsp } from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const text = await fsp.readFile(path, 'utf8')
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/** Write temp file + rename so a crash mid-write never corrupts the store. */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const dir = dirname(path)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`)
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  try {
    await fsp.rename(tmp, path)
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {})
    throw err
  }
}
