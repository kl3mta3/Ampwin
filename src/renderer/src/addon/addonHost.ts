// AddonHost: loads enabled addons into hidden, headless iframes, each with the
// full window.ampwin API (built the same way skins get theirs). An addon is
// just JS — typically it registers a visualizer plugin — so it needs no visible
// document. Each addon lives in its own iframe so its globals/timers are
// isolated and removing the iframe cleans everything up.
//
// Addon-registered visualizer plugins are owned by the addon (not the skin), so
// they survive skin switches and are removed only when the addon is disabled or
// uninstalled (see VisualizerHost.onAddonTeardown).

import type { AmpwinApi } from '../../../shared/skin-api'
import type { AddonInfo } from '../../../shared/types'
import { native } from '../native'
import { buildFacade, type AddonOps, type SkinFacade, type SkinOps } from '../skin/ampwinApi'
import type { BaseFacadeDeps } from '../skin/skinHost'

declare global {
  interface Window {
    /** Called synchronously by the bootstrap script injected into each addon. */
    __ampwinBindAddon?: (addonId: string, addonWindow: Window) => AmpwinApi
  }
}

interface LoadedAddon {
  iframe: HTMLIFrameElement
  facade: SkinFacade | null
}

export class AddonHost {
  private baseDeps: BaseFacadeDeps
  private skinOps: SkinOps | null = null
  private loaded = new Map<string, LoadedAddon>()

  constructor(baseDeps: BaseFacadeDeps) {
    this.baseDeps = baseDeps
    // One permanent binder: the bootstrap passes its own id, so concurrent
    // loads never collide.
    window.__ampwinBindAddon = (addonId, addonWindow) => {
      const facade = buildFacade(this.facadeDeps(), () => {}, { kind: 'addon', addonId })
      const rec = this.loaded.get(addonId)
      if (rec) rec.facade = facade
      // Surface addon script errors to the main-process log — handy when
      // debugging a third-party addon that misbehaves.
      addonWindow.addEventListener('error', (e) => {
        void native.invoke('dev:log', `[addon] "${addonId}" error: ${e.message}`)
      })
      return facade.api
    }
  }

  /** Wired by the shell after the SkinManager exists (addons get the full API). */
  setSkinOps(ops: SkinOps): void {
    this.skinOps = ops
  }

  /** The ops object the facade exposes as ampwin.addons.{setEnabled,uninstall}. */
  readonly ops: AddonOps = {
    setEnabled: async (id, enabled) => {
      await native.invoke('addons:set-enabled', id, enabled)
      if (enabled) {
        const info = (await native.invoke('addons:list')).find((a) => a.id === id)
        if (info) await this.loadAddon(info)
      } else {
        this.unloadAddon(id)
      }
    },
    uninstall: async (id) => {
      this.unloadAddon(id)
      await native.invoke('addons:uninstall', id)
    }
  }

  /** Load every enabled installed addon. Called once at boot; failures are
   *  isolated so one broken addon never blocks the others or the app. */
  async boot(): Promise<void> {
    let enabled: AddonInfo[]
    try {
      enabled = (await native.invoke('addons:list')).filter((a) => a.enabled)
    } catch (err) {
      console.error('failed to list addons at boot', err)
      return
    }
    if (enabled.length) {
      void native.invoke('dev:log', `[addon] loading ${enabled.length}: ${enabled.map((a) => a.id).join(',')}`)
    }
    for (const info of enabled) {
      try {
        await this.loadAddon(info)
      } catch (err) {
        void native.invoke('dev:log', `[addon] "${info.id}" failed to load: ${(err as Error).message}`)
      }
    }
  }

  private facadeDeps(): Parameters<typeof buildFacade>[0] {
    return {
      ...this.baseDeps,
      skinOps: this.skinOps ?? {
        list: () => native.invoke('skins:list'),
        getActiveId: () => 'default',
        setActive: () => Promise.resolve()
      },
      addonOps: this.ops
    }
  }

  private async loadAddon(info: AddonInfo): Promise<void> {
    if (this.loaded.has(info.id)) return
    const iframe = document.createElement('iframe')
    iframe.dataset.addon = info.id
    iframe.style.display = 'none'
    this.loaded.set(info.id, { iframe, facade: null })

    const idJson = JSON.stringify(info.id)
    iframe.srcdoc =
      `<!doctype html><html><head>` +
      `<base href="ampwin://addon/${info.id}/">` +
      `<script>window.ampwin = window.parent.__ampwinBindAddon(${idJson}, window)<\/script>` +
      `<script src="${info.entry}"><\/script>` +
      `</head><body></body></html>`
    // Resolve once the iframe's scripts have run (so the addon's plugins are
    // registered). Awaiting this lets boot() finish addon loading *before* the
    // skin renders its visualizer list — no "reopen the dropdown" race. Capped
    // so a broken/slow addon can never hang startup.
    const ready = new Promise<void>((resolve) => {
      iframe.addEventListener('load', () => resolve())
      setTimeout(resolve, 3000)
    })
    document.getElementById('addon-layer')!.appendChild(iframe)
    await ready
  }

  private unloadAddon(id: string): void {
    const rec = this.loaded.get(id)
    if (!rec) return
    // dispose() → vizHost.onAddonTeardown(id) removes the addon's plugins.
    rec.facade?.dispose()
    rec.iframe.remove()
    this.loaded.delete(id)
  }
}
