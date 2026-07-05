// Ampwin app shell — persistent layer that owns the audio engine, the
// visualizer host, and the skin host. Lives for the whole app lifetime;
// skins come and go inside #skin-layer without ever touching the audio.

import type { Track } from '../../shared/types'
import { native } from './native'
import { createAudioGraph } from './audio/graph'
import { AudioEngine } from './audio/engine'
import { SystemAudioCapture } from './audio/systemAudio'
import { PlayerController } from './playlist/controller'
import { VisualizerHost } from './viz/host'
import { SkinManager } from './skin/skinHost'
import { TrackMenuRegistry } from './skin/menuRegistry'
import { AddonHost } from './addon/addonHost'
import { PlaylistWindow } from './playlist/playlistWindow'

async function boot(): Promise<void> {
  const graph = createAudioGraph(document.getElementById('host-layer')!)
  const engine = new AudioEngine(graph)
  const controller = new PlayerController(engine)
  const vizHost = new VisualizerHost(graph)
  controller.attachVizHost(vizHost) // video plays on the visualizer surface
  const trackMenus = new TrackMenuRegistry()
  const playlistWindow = new PlaylistWindow(controller, trackMenus)
  const systemAudio = new SystemAudioCapture(graph)

  const baseDeps = { controller, engine, vizHost, playlistWindow, systemAudio, trackMenus, eq: graph.eq }
  const skinManager = new SkinManager(baseDeps)
  const addonHost = new AddonHost(baseDeps)
  // Skins and addons both expose the full API, so each needs the other's ops.
  skinManager.setAddonOps(addonHost.ops)
  addonHost.setSkinOps(skinManager.ops)

  // System-audio mode pauses our own playback (you're visualizing another app);
  // starting local playback (audio or video) turns it back off — normal precedence.
  systemAudio.events.on('change', (on) => {
    if (on) controller.pause()
    // Re-init the active visualizer so plugins that wire their audio at init
    // (Butterchurn) re-tap the swapped source; spectrum bars update live anyway.
    void vizHost.refreshForSourceChange()
  })
  controller.events.on('state', (s) => {
    if ((s === 'playing' || s === 'loading') && systemAudio.isEnabled()) systemAudio.disable()
  })

  // MilkDrop-style song title flourish + lyrics overlay on track change.
  // Lyrics precedence: embedded/.lrc on the track → else fetch human-made synced
  // lyrics from LRCLIB (when the lyrics toggle is on) → else nothing (an addon
  // like auto-lyrics may still transcribe). A token guards against a slow online
  // fetch landing after the track has already changed.
  let lyricsToken = 0
  const maybeFetchOnline = (t: Track | null, token: number): void => {
    if (!t || t.lyrics || !t.title || !vizHost.lyricsEnabled()) return
    native
      .invoke('lyrics:fetch-online', { artist: t.artist, title: t.title, album: t.album, durationSec: t.durationSec })
      .then((found) => {
        if (found && token === lyricsToken) vizHost.setLyrics(found)
      })
      .catch(() => {})
  }
  controller.events.on('track', (t) => {
    const token = ++lyricsToken
    if (t) vizHost.showTitle(`${t.artist ? t.artist + ' - ' : ''}${t.title}`)
    vizHost.setLyrics(t?.lyrics ?? null)
    maybeFetchOnline(t, token)
  })
  // Turning the lyrics toggle on mid-song: fetch for the current track if it has none.
  vizHost.events.on('lyrics-enabled', (on) => {
    if (!on || vizHost.lyricsAvailable()) return
    maybeFetchOnline(controller.getSnapshot().track, ++lyricsToken)
  })
  // Drive the synced-lyric highlight from the ~4 Hz playback position.
  controller.events.on('position', (posSec) => vizHost.setLyricsPosition(posSec * 1000))

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
    onVolume: (cb) => controller.events.on('volume', (v) => cb(v)),
    getPosition: () => controller.getSnapshot().positionSec,
    getDuration: () => controller.getSnapshot().durationSec,
    seek: (sec) => controller.seekTo(sec),
    onPosition: (cb) => controller.events.on('position', (pos, dur) => cb(pos, dur))
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
  graph.eq.load(settings.eq)
  await controller.restore(settings)
  // Load addons before the skin so addon-provided visualizers are registered
  // by the time the skin attaches its canvas and picks the active visualizer.
  await addonHost.boot()
  await skinManager.boot()

  if (native.demoPath) {
    await controller.openPaths([native.demoPath])
  }

  if (native.selftestPath) {
    const { runSelfTest } = await import('./selftest')
    await runSelfTest(native.selftestPath, controller, skinManager, vizHost, systemAudio, graph.eq)
  }
}

void boot()

export {}
