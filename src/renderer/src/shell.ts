// Ampwin app shell — persistent layer that owns the audio engine, the
// visualizer host, and the skin host. Lives for the whole app lifetime;
// skins come and go inside #skin-layer without ever touching the audio.

import { native } from './native'
import { createAudioGraph } from './audio/graph'
import { AudioEngine } from './audio/engine'
import { PlayerController } from './playlist/controller'
import { VisualizerHost } from './viz/host'
import { SkinManager } from './skin/skinHost'
import { PlaylistWindow } from './playlist/playlistWindow'

async function boot(): Promise<void> {
  const graph = createAudioGraph(document.getElementById('host-layer')!)
  const engine = new AudioEngine(graph)
  const controller = new PlayerController(engine)
  const vizHost = new VisualizerHost(graph)
  controller.attachVizHost(vizHost) // video plays on the visualizer surface
  const playlistWindow = new PlaylistWindow(controller)
  const skinManager = new SkinManager({ controller, engine, vizHost, playlistWindow })

  // MilkDrop-style song title flourish on track change.
  controller.events.on('track', (t) => {
    if (t) vizHost.showTitle(`${t.artist ? t.artist + ' - ' : ''}${t.title}`)
  })

  // Transport controls in the visualizer pop-out's title bar.
  vizHost.attachTransport({
    togglePlay: () => controller.togglePlay(),
    stop: () => controller.stop(),
    next: () => void controller.next(),
    previous: () => void controller.previous(),
    getState: () => controller.getSnapshot().state,
    onState: (cb) => controller.events.on('state', cb),
    getVolume: () => controller.getSnapshot().volume,
    setVolume: (v) => controller.setVolume(v),
    onVolume: (cb) => controller.events.on('volume', (v) => cb(v))
  })

  // OS "Open with" / second-instance file handoff.
  native.on('evt:os-open-files', ({ paths }) => void controller.openPaths(paths))

  // F12 → DevTools; Ctrl+Shift+D → escape to the default skin.
  // (Also wired inside each skin document by the skin host.)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F12') void native.invoke('window:toggle-devtools')
    if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === 'D') {
      void skinManager.setActive('default')
    }
  })

  // Global media keys (main process) + Windows SMTC metadata.
  native.on('evt:media-key', (action) => {
    switch (action) {
      case 'play-pause':
        controller.togglePlay()
        break
      case 'next':
        void controller.next()
        break
      case 'prev':
        void controller.previous()
        break
      case 'stop':
        controller.stop()
        break
    }
  })

  controller.events.on('track', (t) => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = t
      ? new MediaMetadata({ title: t.title, artist: t.artist, album: t.album })
      : null
  })
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => controller.play())
    navigator.mediaSession.setActionHandler('pause', () => controller.pause())
    navigator.mediaSession.setActionHandler('previoustrack', () => void controller.previous())
    navigator.mediaSession.setActionHandler('nexttrack', () => void controller.next())
  }

  // Restore session first so the skin's first render sees the playlist.
  const settings = await native.invoke('store:settings:get')
  vizHost.init(settings)
  await controller.restore(settings)
  await skinManager.boot()

  if (native.demoPath) {
    await controller.openPaths([native.demoPath])
  }

  if (native.selftestPath) {
    const { runSelfTest } = await import('./selftest')
    await runSelfTest(native.selftestPath, controller, skinManager, vizHost)
  }
}

void boot()

export {}
