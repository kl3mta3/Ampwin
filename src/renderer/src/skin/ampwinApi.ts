// Builds the per-skin-instance window.ampwin facade. Every subscription and
// drag region a skin creates is tracked here so dispose() can unhook all of
// it - skin switches never leak listeners into the persistent engine.

import type { AmpwinApi, VisualizerPlugin } from '../../../shared/skin-api'
import type { Playlist, Track } from '../../../shared/types'
import { native } from '../native'
import type { AudioEngine } from '../audio/engine'
import type { PlayerController } from '../playlist/controller'
import type { VisualizerHost } from '../viz/host'
import type { PlaylistWindow } from '../playlist/playlistWindow'
import type { SystemAudioCapture } from '../audio/systemAudio'
import { DragRegionMirror } from './dragRegions'

export interface SkinOps {
  list: AmpwinApi['skins']['list']
  getActiveId: () => string
  setActive: (id: string) => Promise<void>
}

/** Enable/disable + uninstall route through the AddonHost so the loaded-iframe
 *  set stays in sync with the persisted setting. */
export interface AddonOps {
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  uninstall: (id: string) => Promise<void>
}

export interface FacadeDeps {
  controller: PlayerController
  engine: AudioEngine
  vizHost: VisualizerHost
  playlistWindow: PlaylistWindow
  systemAudio: SystemAudioCapture
  skinOps: SkinOps
  addonOps: AddonOps
}

export interface SkinFacade {
  api: AmpwinApi
  dispose(): void
}

/** Who owns this facade instance — decides plugin lifetime + teardown. */
export type FacadeOwner = { kind: 'skin' } | { kind: 'addon'; addonId: string }

export function buildFacade(
  deps: FacadeDeps,
  onReady: () => void,
  owner: FacadeOwner = { kind: 'skin' }
): SkinFacade {
  const { controller, vizHost, playlistWindow, systemAudio, skinOps, addonOps } = deps
  const unsubs: (() => void)[] = []
  const dragMirror = new DragRegionMirror()
  let disposed = false
  const pluginOwner = owner.kind === 'skin' ? 'skin' : (`addon:${owner.addonId}` as const)

  const track = <T extends () => void>(unsub: T): T => {
    unsubs.push(unsub)
    return unsub
  }

  const api: AmpwinApi = {
    apiVersion: 1,

    ready() {
      onReady()
    },

    player: {
      play: () => controller.play(),
      pause: () => controller.pause(),
      stop: () => controller.stop(),
      togglePlay: () => controller.togglePlay(),
      next: () => void controller.next(),
      previous: () => void controller.previous(),
      seek: (seconds) => controller.seekTo(seconds),
      setVolume: (v) => controller.setVolume(v),
      setMuted: (m) => controller.setMuted(m),
      setShuffle: (on) => controller.setShuffle(on),
      setRepeat: (mode) => controller.setRepeat(mode),
      getSnapshot: () => controller.getSnapshot(),
      on: ((ev: string, cb: (...args: any[]) => void) => {
        switch (ev) {
          case 'state':
            return track(controller.events.on('state', cb))
          case 'track':
            return track(controller.events.on('track', cb))
          case 'position':
            return track(controller.events.on('position', cb))
          case 'volume':
            return track(controller.events.on('volume', cb))
          case 'mode':
            return track(controller.model.events.on('mode', cb))
          case 'error':
            return track(controller.events.on('error', cb))
          default:
            return () => {}
        }
      }) as AmpwinApi['player']['on']
    },

    playlist: {
      getTracks: () => controller.model.getTracks(),
      getCurrentIndex: () => controller.model.getCurrentIndex(),
      playIndex: (i) => void controller.playIndex(i),
      addPaths: (paths, atIndex) => controller.addPaths(paths, atIndex),
      removeIndices: (indices) => controller.model.removeIndices(indices),
      move: (from, to) => controller.model.move(from, to),
      clear: () => {
        controller.stop()
        controller.model.clear()
      },
      queueNext: (index) => controller.model.queueNext(index),
      popOut: () => playlistWindow.toggle(),
      on: ((ev: string, cb: (...args: any[]) => void) => {
        if (ev === 'changed') return track(controller.model.events.on('changed', cb))
        return () => {}
      }) as AmpwinApi['playlist']['on'],
      saved: {
        list: async () => {
          const metas = await native.invoke('store:playlists:list')
          return metas.map((m) => ({ id: m.id, name: m.name, trackCount: m.trackCount }))
        },
        load: async (id) => {
          const pl = await native.invoke('store:playlists:get', id)
          controller.stop()
          controller.model.replaceAll(pl.tracks, pl.tracks.length > 0 ? 0 : -1)
        },
        saveCurrentAs: async (name) => {
          const now = Date.now()
          const id =
            name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '')
              .slice(0, 40) +
            '-' +
            now.toString(36)
          const pl: Playlist = {
            id,
            name,
            tracks: controller.model.getTracks(),
            createdAt: now,
            updatedAt: now
          }
          await native.invoke('store:playlists:save', pl)
          return id
        },
        delete: (id) => native.invoke('store:playlists:delete', id),
        importFromFile: async () => {
          const paths = await native.invoke('dialog:open-files', 'playlist')
          if (paths.length > 0) await controller.importPlaylistFile(paths[0])
        },
        exportToFile: async (fmt = 'm3u8') => {
          const target = await native.invoke('dialog:save-file', {
            defaultName: `playlist.${fmt}`,
            filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }]
          })
          if (!target) return
          const now = Date.now()
          const pl: Playlist = {
            id: 'export',
            name: 'export',
            tracks: controller.model.getTracks(),
            createdAt: now,
            updatedAt: now
          }
          await native.invoke('playlist:export', pl, target, fmt, false)
        }
      }
    },

    files: {
      openFilesDialog: () => native.invoke('dialog:open-files', 'media'),
      openFolderDialog: async () => {
        const folder = await native.invoke('dialog:open-folder')
        return folder ? native.invoke('scan:folder', folder) : []
      },
      getArtworkUrl: (t: Track) => native.invoke('media:artwork', t.path),
      pathForDroppedFile: (file) => native.pathForFile(file),
      openPaths: (paths) => controller.openPaths(paths)
    },

    visualizer: {
      attach: (canvas) => vizHost.attach(canvas),
      detach: () => vizHost.detach(),
      listPresets: () => vizHost.listPresets(),
      loadPreset: (id, blendSec) => vizHost.loadPreset(id, blendSec),
      nextPreset: () => vizHost.nextPreset(),
      prevPreset: () => vizHost.prevPreset(),
      randomPreset: () => vizHost.randomPreset(),
      setCycle: (opts) => vizHost.setCycle(opts),
      importPresetFiles: () => vizHost.importPresetFiles(),
      setFullscreen: (on) => void vizHost.setFullscreen(on),
      popOut: () => vizHost.popOut(),
      getActiveVisualizerId: () => vizHost.getActiveVisualizerId(),
      listVisualizers: () => vizHost.listVisualizers(),
      setActiveVisualizer: (id) => void vizHost.setActiveVisualizer(id),
      registerPlugin: (plugin: VisualizerPlugin) => vizHost.registerPlugin(plugin, pluginOwner),
      on: ((ev: string, cb: (...args: any[]) => void) => {
        if (ev === 'preset') return track(vizHost.events.on('preset', cb))
        if (ev === 'visualizers') return track(vizHost.events.on('visualizers', cb))
        return () => {}
      }) as AmpwinApi['visualizer']['on']
    },

    window: {
      minimize: () => void native.invoke('window:minimize'),
      close: () => void native.invoke('window:close'),
      setDragRegion: (el, opts) => track(dragMirror.add(el, opts?.exclude ?? [])),
      setSize: (w, h) => void native.invoke('window:set-size', w, h),
      setAlwaysOnTop: (on) => void native.invoke('window:set-always-on-top', on)
    },

    skins: {
      list: () => skinOps.list(),
      getActiveId: () => skinOps.getActiveId(),
      setActive: (id) => skinOps.setActive(id),
      openSkinsFolder: () => void native.invoke('skins:open-folder')
    },

    system: {
      isEnabled: () => systemAudio.isEnabled(),
      enable: () => systemAudio.enable(),
      disable: () => systemAudio.disable(),
      toggle: () => systemAudio.toggle(),
      on: ((ev: string, cb: (...args: any[]) => void) => {
        if (ev === 'change') return track(systemAudio.events.on('change', cb))
        return () => {}
      }) as AmpwinApi['system']['on']
    },

    addons: {
      list: () => native.invoke('addons:list'),
      catalog: () => native.invoke('addons:catalog'),
      install: (id) => native.invoke('addons:install', id),
      setEnabled: (id, enabled) => addonOps.setEnabled(id, enabled),
      uninstall: (id) => addonOps.uninstall(id),
      openFolder: () => void native.invoke('addons:open-folder'),
      on: ((ev: string, cb: (...args: any[]) => void) => {
        if (ev === 'progress') {
          return track(native.on('evt:addon-progress', ({ id, percent }) => cb(id, percent)))
        }
        return () => {}
      }) as AmpwinApi['addons']['on']
    },

    convert: {
      list: (isVideo) => native.invoke('convert:list', isVideo),
      start: (t, formatId) => controller.convertTrack(t, formatId),
      openFolder: () => void native.invoke('convert:open-folder'),
      on: ((ev: string, cb: (...args: any[]) => void) => {
        if (ev === 'progress') {
          return track(native.on('evt:convert-progress', ({ percent }) => cb(percent)))
        }
        return () => {}
      }) as AmpwinApi['convert']['on']
    },

    links: {
      ytdlpInstalled: async () => (await native.invoke('ytdlp:status')).installed,
      ensureYtDlp: () => native.invoke('ytdlp:ensure'),
      add: (url, audioOnly) => controller.addLink(url, audioOnly),
      addSearchResult: (result, audioOnly) => controller.addSearchResult(result, audioOnly),
      addPlaylist: (url, audioOnly) => controller.addPlaylist(url, audioOnly),
      download: (t, kind) => controller.downloadTrack(t, kind),
      openDownloadsFolder: () => void native.invoke('downloads:open-folder'),
      search: (query) => native.invoke('yt:search', query),
      signInYouTube: () => native.invoke('yt:signin'),
      isYouTubeSignedIn: () => native.invoke('yt:signed-in'),
      signOutYouTube: () => native.invoke('yt:sign-out'),
      on: ((ev: string, cb: (...args: any[]) => void) => {
        if (ev === 'download') {
          return track(native.on('evt:ytdlp-progress', ({ percent }) => cb(percent)))
        }
        if (ev === 'fileProgress') {
          return track(native.on('evt:download-progress', ({ percent, phase }) => cb({ percent, phase })))
        }
        return () => {}
      }) as AmpwinApi['links']['on']
    }
  }

  return {
    api,
    dispose() {
      if (disposed) return
      disposed = true
      for (const u of unsubs) u()
      unsubs.length = 0
      dragMirror.destroy()
      if (owner.kind === 'skin') vizHost.onSkinTeardown()
      else vizHost.onAddonTeardown(owner.addonId)
    }
  }
}
