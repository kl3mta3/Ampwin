// SkinManager: loads skin documents into the #skin-layer iframe via srcdoc
// (same-origin in dev and prod, so the API object crosses directly), enforces
// the ready() handshake, tears down leak-free, and falls back to the default
// skin — or a hardcoded emergency UI — when a skin fails. The audio engine
// lives outside the iframe and is never touched by a skin switch.

import type { AmpwinApi } from '../../../shared/skin-api'
import { native } from '../native'
import { buildFacade, type FacadeDeps, type SkinFacade } from './ampwinApi'

const READY_TIMEOUT_MS = 5000

declare global {
  interface Window {
    /** Called synchronously by the bootstrap script injected into each skin. */
    __ampwinBind?: (skinWindow: Window) => AmpwinApi
  }
}

export class SkinManager {
  private baseDeps: Omit<FacadeDeps, 'skinOps'>
  private activeId = 'default'
  private current: { facade: SkinFacade; iframe: HTMLIFrameElement } | null = null
  private switching = false

  constructor(baseDeps: Omit<FacadeDeps, 'skinOps'>) {
    this.baseDeps = baseDeps
  }

  getActiveId(): string {
    return this.activeId
  }

  async boot(): Promise<void> {
    const settings = await native.invoke('store:settings:get')
    // Crash-loop guard: bootFailures increments before skin boot and resets
    // after success. Two unclean boots in a row force the default skin.
    let target = settings.activeSkin || 'default'
    if (settings.bootFailures >= 2 && target !== 'default') {
      console.warn(`skin "${target}" crashed the last ${settings.bootFailures} boots — forcing default`)
      target = 'default'
    }
    await native.invoke('store:settings:patch', { bootFailures: settings.bootFailures + 1 })

    try {
      await this.activate(target, false) // keep restored window bounds
    } catch (err) {
      console.error(`skin "${target}" failed to boot:`, err)
      if (target !== 'default') {
        try {
          await this.activate('default', false)
          void native.invoke('store:settings:patch', { activeSkin: 'default' })
        } catch (err2) {
          this.emergencyUI(err2)
        }
      } else {
        this.emergencyUI(err)
      }
    }
    void native.invoke('store:settings:patch', { bootFailures: 0 })
  }

  /** Hot-swap skins; audio keeps playing. Persists on success, reverts to
   *  default on failure. */
  async setActive(id: string): Promise<void> {
    if (this.switching) return
    if (id === this.activeId && this.current) return
    try {
      await this.activate(id)
      void native.invoke('store:settings:patch', { activeSkin: id })
    } catch (err) {
      console.error(`skin "${id}" failed to activate:`, err)
      if (id !== 'default') await this.activate('default').catch((e) => this.emergencyUI(e))
      throw err
    }
  }

  private teardown(): void {
    this.current?.facade.dispose()
    this.current?.iframe.remove()
    this.current = null
  }

  private async activate(id: string, applySize = true): Promise<void> {
    if (this.switching) throw new Error('skin switch already in progress')
    this.switching = true
    try {
      const skins = await native.invoke('skins:list')
      const info = skins.find((s) => s.id === id)
      if (!info) throw new Error(`unknown skin: ${id}`)

      const { html, baseUrl } = await native.invoke('skins:read-entry', id)

      this.teardown()
      await native.invoke('window:apply-skin-spec', info.window, applySize)

      let readyResolve!: () => void
      let readyReject!: (e: Error) => void
      const ready = new Promise<void>((res, rej) => {
        readyResolve = res
        readyReject = rej
      })
      const timer = setTimeout(
        () => readyReject(new Error(`skin did not call ampwin.ready() within ${READY_TIMEOUT_MS}ms`)),
        READY_TIMEOUT_MS
      )

      // Holder object: assignment happens inside the bind closure, which
      // TS control-flow analysis can't track through a plain local.
      const holder: { facade: SkinFacade | null } = { facade: null }
      let readyCalled = false
      window.__ampwinBind = (skinWindow: Window): AmpwinApi => {
        holder.facade = buildFacade(
          {
            ...this.baseDeps,
            skinOps: {
              list: () => native.invoke('skins:list'),
              getActiveId: () => this.activeId,
              setActive: (nextId) => this.setActive(nextId)
            }
          },
          () => {
            readyCalled = true
            readyResolve()
          }
        )
        // A script error before ready() means the skin is broken — reject it.
        skinWindow.addEventListener('error', (e) => {
          if (!readyCalled) readyReject(new Error(`skin script error: ${e.message}`))
        })
        // Key events land in the skin document, not the shell — wire the
        // global chords here too. Ctrl+Shift+D is the escape hatch: no skin
        // (however broken its UI) can trap the user away from the default.
        skinWindow.addEventListener('keydown', (e) => {
          const ke = e as KeyboardEvent
          if (ke.key === 'F12') void native.invoke('window:toggle-devtools')
          if (ke.ctrlKey && ke.shiftKey && ke.key.toUpperCase() === 'D') {
            void this.setActive('default')
          }
        })
        return holder.facade.api
      }

      const iframe = document.createElement('iframe')
      iframe.id = 'skin-frame'
      iframe.srcdoc = buildSrcdoc(html, baseUrl)
      document.getElementById('skin-layer')!.appendChild(iframe)

      try {
        await ready
      } catch (err) {
        holder.facade?.dispose()
        iframe.remove()
        throw err
      } finally {
        clearTimeout(timer)
        window.__ampwinBind = undefined
      }

      this.current = { facade: holder.facade!, iframe }
      this.activeId = id
    } finally {
      this.switching = false
    }
  }

  /** Last resort if even the default skin can't boot: never brick-dead. */
  private emergencyUI(err: unknown): void {
    this.teardown()
    const { controller, engine } = this.baseDeps
    const layer = document.getElementById('skin-layer')!
    layer.innerHTML = `
      <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;
                  gap:12px;background:#1a0505;color:#f0c0c0;font-family:sans-serif;-webkit-app-region:drag">
        <div style="font-weight:bold">Skin system failed — emergency controls</div>
        <div style="font-size:12px;max-width:80%;text-align:center">${String((err as Error)?.message ?? err)}</div>
        <div style="display:flex;gap:8px;-webkit-app-region:no-drag">
          <button id="em-play">play/pause</button>
          <button id="em-next">next</button>
          <button id="em-close">close</button>
        </div>
      </div>`
    document.getElementById('em-play')!.addEventListener('click', () => {
      if (engine.getState() === 'playing') engine.pause()
      else void engine.play()
    })
    document.getElementById('em-next')!.addEventListener('click', () => void controller.next())
    document.getElementById('em-close')!.addEventListener('click', () => void native.invoke('window:close'))
  }
}

/** Inject <base> (relative skin assets resolve to ampwin://skin/<id>/) and the
 *  API bootstrap ahead of all skin content, so window.ampwin is available
 *  synchronously before any skin script runs. */
function buildSrcdoc(html: string, baseUrl: string): string {
  const inject =
    `<base href="${baseUrl}">` +
    `<script>window.ampwin = window.parent.__ampwinBind(window)</script>`
  const headMatch = /<head[^>]*>/i.exec(html)
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length
    return html.slice(0, at) + inject + html.slice(at)
  }
  return inject + html
}
