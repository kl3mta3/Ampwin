// YouTube sign-in: opens a real browser window in an isolated persistent
// session partition so the user can log in (and pass any verification).
// On close, the partition's youtube/google cookies are exported to a
// Netscape cookies.txt that yt-dlp reads via --cookies. This unblocks
// age-restricted / region-locked / rate-limited videos.

import { BrowserWindow, session, type Cookie } from 'electron'
import { promises as fsp } from 'fs'
import { cookiesPath } from './ytdlp'

const PARTITION = 'persist:youtube'

export async function isSignedIn(): Promise<boolean> {
  try {
    await fsp.access(cookiesPath())
    // A logged-in session has the SID/LOGIN_INFO cookies; a bare cookies file
    // (consent only) doesn't count.
    const txt = await fsp.readFile(cookiesPath(), 'utf8')
    return /\bLOGIN_INFO\b|\bSID\b/.test(txt)
  } catch {
    return false
  }
}

export async function signOut(): Promise<void> {
  await fsp.unlink(cookiesPath()).catch(() => {})
  const ses = session.fromPartition(PARTITION)
  await ses.clearStorageData().catch(() => {})
}

export function openSignIn(parent: BrowserWindow | null): Promise<{ signedIn: boolean }> {
  return new Promise((resolve) => {
    const ses = session.fromPartition(PARTITION)
    const win = new BrowserWindow({
      width: 520,
      height: 680,
      parent: parent ?? undefined,
      modal: false,
      title: 'Sign in to YouTube',
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, sandbox: true }
    })

    let done = false
    const finish = async (): Promise<void> => {
      if (done) return
      done = true
      try {
        await exportCookies(ses)
      } catch (err) {
        console.error('cookie export failed', err)
      }
      const signedIn = await isSignedIn()
      if (!win.isDestroyed()) win.destroy()
      resolve({ signedIn })
    }

    // Once signed in, YouTube redirects back to youtube.com — export then.
    win.webContents.on('did-navigate', (_e, url) => {
      if (/^https:\/\/(www\.)?youtube\.com\//.test(url)) {
        void exportCookies(ses).catch(() => {})
      }
    })
    win.on('closed', () => void finish())

    void win.loadURL('https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F')
  })
}

async function exportCookies(ses: Electron.Session): Promise<void> {
  const cookies: Cookie[] = []
  for (const domain of ['.youtube.com', '.google.com']) {
    cookies.push(...(await ses.cookies.get({ domain })))
  }
  const lines = ['# Netscape HTTP Cookie File', '# Exported by Ampwin', '']
  for (const c of cookies) {
    const domain = c.domain ?? ''
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE'
    const secure = c.secure ? 'TRUE' : 'FALSE'
    const expiry = Math.floor(c.expirationDate ?? 0)
    lines.push([domain, includeSub, c.path || '/', secure, expiry, c.name, c.value].join('\t'))
  }
  await fsp.writeFile(cookiesPath(), lines.join('\n'), 'utf8')
}
