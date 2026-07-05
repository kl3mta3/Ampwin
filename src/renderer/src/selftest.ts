// Dev-only self-test, run when AMPWIN_SELFTEST=<absolute media path>.
// Exercises probe → prepare → protocol fetch with Range → engine playback →
// seek → auto-advance. Results land in main stdout via dev:log; the app
// quits itself when done.

import { native } from './native'
import type { Lyrics } from '../../shared/types'
import type { PlayerController } from './playlist/controller'
import type { SkinManager } from './skin/skinHost'
import type { VisualizerHost } from './viz/host'
import type { SystemAudioCapture } from './audio/systemAudio'
import type { Equalizer } from './audio/eq'
import type { VisualizerPlugin } from './viz/plugin'

export async function runSelfTest(
  path: string,
  controller: PlayerController,
  skinManager: SkinManager,
  vizHost: VisualizerHost,
  systemAudio?: SystemAudioCapture,
  eq?: Equalizer
): Promise<void> {
  const results: string[] = []
  let failed = false

  const check = (name: string, ok: boolean, detail = ''): void => {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failed = true
  }

  // AMPWIN_SELFTEST=youtube → exercise the link/yt-dlp path against live YouTube.
  if (path === 'youtube') {
    await runYtTest(controller, check)
    await finish()
    return
  }

  // AMPWIN_SELFTEST=addons → verify a pre-seeded+enabled addon loaded, registered
  // a visualizer, renders, and survives a skin switch (addon-owned lifetime).
  if (path === 'addons') {
    await runAddonLoadTest(skinManager, vizHost, check)
    await finish()
    return
  }

  // AMPWIN_SELFTEST=embed → verify the YouTube-embed fallback mounts, plays,
  // and tears down (the fallback for videos we can't extract a stream for).
  if (path === 'embed') {
    await runEmbedTest(vizHost, check)
    await finish()
    return
  }

  // AMPWIN_SELFTEST=stems → REAL end-to-end HTDemucs separation on test-media/
  // tone.flac with the 6s model (downloads ~130MB into userData/models on the
  // first run). Verifies engine → onnxruntime → cached WAVs → export.
  if (path === 'stems') {
    await runStemsTest(check)
    await finish()
    return
  }

  // AMPWIN_SELFTEST=lyrics → the Black Screen built-in visualizer + the synced
  // lyrics overlay (availability, position-driven highlight, live source).
  if (path === 'lyrics') {
    await runLyricsTest(vizHost, check)
    await finish()
    return
  }


  // AMPWIN_SELFTEST=lyrics-online → live LRCLIB fetch of a known song's synced
  // lyrics + the userData cache (the reliable primary lyrics source).
  if (path === 'lyrics-online') {
    await runOnlineLyricsTest(check)
    await finish()
    return
  }

  // AMPWIN_SELFTEST=eq → the graphic EQ applies its band gains to the Web Audio
  // biquads when enabled and is transparent (0 dB) when disabled.
  if (path === 'eq') {
    runEqTest(eq, check)
    await finish()
    return
  }

  try {
    const [probe] = await native.invoke('media:probe', [path])
    check('probe ok', probe.ok, `codec=${probe.codec} verdict=${probe.verdict} dur=${probe.durationSec.toFixed(1)}s`)

    // prepare/Range checks exercise the audio path — video goes through
    // media:video-plan + progressive streaming instead (and pre-transcoding a
    // long video here would defeat the play-while-converting test).
    if (!probe.isVideo) {
      const prepared = await native.invoke('media:prepare', path)
      const url = prepared.url
      check('prepare returns ampwin url', url.startsWith('ampwin://media/'), url.slice(0, 40))
      check(
        'transcoded flag matches verdict',
        prepared.transcoded === (probe.verdict === 'transcode'),
        `verdict=${probe.verdict} transcoded=${prepared.transcoded}`
      )

      const full = await fetch(url)
      const fullLen = Number(full.headers.get('content-length'))
      check('full fetch 200', full.status === 200, `len=${fullLen}`)

      const ranged = await fetch(url, { headers: { range: 'bytes=100-199' } })
      const body = await ranged.arrayBuffer()
      check(
        'range fetch 206',
        ranged.status === 206 && body.byteLength === 100,
        `status=${ranged.status} got=${body.byteLength}B content-range=${ranged.headers.get('content-range')}`
      )

      const suffix = await fetch(url, { headers: { range: 'bytes=-50' } })
      const sBody = await suffix.arrayBuffer()
      check('suffix range 206', suffix.status === 206 && sBody.byteLength === 50)
    } else {
      const plan = await native.invoke('media:video-plan', path)
      check(
        'video plan matches verdict',
        plan.direct === (probe.verdict === 'native') && plan.durationSec > 0,
        `direct=${plan.direct} dur=${plan.durationSec.toFixed(1)}s`
      )
    }

    // The restored session may contain tracks from previous runs — start from
    // a clean playlist so index 0 is really the file under test.
    controller.stop()
    controller.model.replaceAll([], -1)

    if (probe.isVideo) {
      // ---- video on the visualizer surface ----------------------------------
      await controller.addPaths([path, path])
      const startedAt = performance.now()
      await controller.playIndex(0)
      // Poll until frames flow (playing + real duration) — measures start
      // latency: streamed conversions must begin long before they finish.
      let waited = 0
      while (
        (controller.getSnapshot().state !== 'playing' || controller.getSnapshot().durationSec <= 0) &&
        waited < 12000
      ) {
        await sleep(250)
        waited += 250
      }
      const startLatency = performance.now() - startedAt
      let snap = controller.getSnapshot()
      check(
        'video plays on visualizer surface',
        snap.state === 'playing' && snap.durationSec > 10 && vizHost.getDebugInfo().mode === 'video',
        `state=${snap.state} dur=${snap.durationSec.toFixed(1)}s mode=${vizHost.getDebugInfo().mode}`
      )
      check(
        'video starts quickly (streams while converting)',
        startLatency < 8000,
        `${(startLatency / 1000).toFixed(1)}s to playing`
      )

      // Video-as-visualizer option: "Video" is offered + selected while a video
      // plays; switching to a real visualizer keeps the video playing (hidden,
      // feeding the analyser); switching back shows the video again.
      check('Video appears in the visualizer list', vizHost.listVisualizers().some((v) => v.id === 'video'))
      check('Video is the selected entry while a video plays', vizHost.getActiveVisualizerId() === 'video')
      await vizHost.setActiveVisualizer('bars')
      await sleep(1500)
      check(
        'switching to a visualizer keeps the video playing (hidden)',
        vizHost.getDebugInfo().mode === 'viz' &&
          vizHost.getActiveVisualizerId() === 'bars' &&
          controller.getSnapshot().state === 'playing',
        `mode=${vizHost.getDebugInfo().mode} active=${vizHost.getActiveVisualizerId()} state=${controller.getSnapshot().state}`
      )
      await vizHost.setActiveVisualizer('video')
      await sleep(500)
      check('switching back to Video shows the video', vizHost.getDebugInfo().mode === 'video', `mode=${vizHost.getDebugInfo().mode}`)

      await sleep(1200) // let position advance before the seek test

      const target = snap.durationSec / 2
      controller.seekTo(target)
      await sleep(900)
      snap = controller.getSnapshot()
      check('video seek lands', Math.abs(snap.positionSec - target) < 2.5, `wanted=${target.toFixed(1)} got=${snap.positionSec.toFixed(1)}`)

      controller.pause()
      await sleep(700)
      check('video pause', controller.getSnapshot().state === 'paused')
      controller.play()
      await sleep(700)
      check('video resume', controller.getSnapshot().state === 'playing')

      controller.seekTo(controller.getSnapshot().durationSec - 2)
      await sleep(5000)
      snap = controller.getSnapshot()
      check(
        'video auto-advance to next track',
        controller.model.getCurrentIndex() === 1 && snap.state === 'playing',
        `index=${controller.model.getCurrentIndex()} state=${snap.state}`
      )

      controller.stop()
      await sleep(400)
      check(
        'video stop returns to visualizer',
        controller.getSnapshot().state === 'idle' && vizHost.getDebugInfo().mode === 'viz',
        `state=${controller.getSnapshot().state} mode=${vizHost.getDebugInfo().mode}`
      )

      // convert: extract audio (mp3) and re-encode video (mkv)
      const vt = controller.model.getTracks().find((t) => t.isVideo && !t.isRemote)
      if (vt) {
        const mp3 = await controller.convertTrack(vt, 'mp3')
        check('convert video → audio-only mp3', typeof mp3 === 'string' && /\.mp3$/i.test(mp3!), mp3 ?? 'null')
        const mkv = await controller.convertTrack(vt, 'mkv')
        check('convert video → mkv', typeof mkv === 'string' && /\.mkv$/i.test(mkv!), mkv ?? 'null')
        if (mkv) {
          const [p] = await native.invoke('media:probe', [mkv])
          check('converted video is valid', p.ok && p.durationSec > 0, `codec=${p.codec} dur=${p.durationSec.toFixed(1)}s`)
        }
      }

      await finish()
      return
    }

    // Engine path: add twice so auto-advance is testable.
    const engine = controller.engine
    await controller.addPaths([path, path])
    await controller.playIndex(0)
    check(
      'playing the file under test',
      controller.model.getCurrentTrack()?.path === path,
      controller.model.getCurrentTrack()?.path ?? 'none'
    )
    check(
      'engine plays',
      engine.getState() === 'playing' && engine.getDuration() > 0,
      `state=${engine.getState()} duration=${engine.getDuration().toFixed(1)}s`
    )

    const dur = engine.getDuration()
    const target = dur / 2
    engine.seek(target)
    await sleep(400)
    check('seek lands', Math.abs(engine.getPosition() - target) < 1, `wanted=${target.toFixed(2)} got=${engine.getPosition().toFixed(2)}`)

    const before = engine.getPosition()
    await sleep(1200)
    check('playback advances after seek', engine.getPosition() > before + 0.5, `${before.toFixed(2)} → ${engine.getPosition().toFixed(2)}`)

    // Seek near the end; the engine should preload (dual element) and the
    // controller should auto-advance to index 1.
    engine.seek(dur - 3)
    await sleep(4500)
    check(
      'auto-advance to next track',
      controller.model.getCurrentIndex() === 1 && engine.getState() === 'playing',
      `index=${controller.model.getCurrentIndex()} state=${engine.getState()}`
    )

    engine.pause()
    check('pause works', engine.getState() === 'paused')
    await engine.play()
    check('resume works', engine.getState() === 'playing')

    // ---- M3: skin system ---------------------------------------------------
    if (skinManager.getActiveId() !== 'default') await skinManager.setActive('default')
    check('default skin active', skinManager.getActiveId() === 'default')
    check('skin iframe mounted', !!document.getElementById('skin-frame'))
    const overlayDivs = document.querySelectorAll('#overlay-layer div')
    const hasDragMirror = [...overlayDivs].some(
      (d) => (d as HTMLElement).style.getPropertyValue('-webkit-app-region') === 'drag'
    )
    check('drag-region overlay mirrored', hasDragMirror, `${overlayDivs.length} overlay divs`)

    // Hot-swap mid-song: audio must never stop.
    const posBefore = engine.getPosition()
    await skinManager.setActive('lite')
    const playingAcross = engine.getState() === 'playing'
    await sleep(800)
    const posAfter = engine.getPosition()
    check(
      'skin hot-swap keeps audio playing',
      playingAcross && posAfter > posBefore,
      `lite active=${skinManager.getActiveId() === 'lite'} pos ${posBefore.toFixed(2)} → ${posAfter.toFixed(2)}`
    )
    await skinManager.setActive('default')
    check('swap back to default', skinManager.getActiveId() === 'default' && engine.getState() === 'playing')

    // The SKINS.md tutorial example, when installed as a user skin, must work.
    const skinList = await native.invoke('skins:list')
    if (skinList.some((s) => s.id === 'tutorial')) {
      await skinManager.setActive('tutorial')
      await sleep(600)
      check(
        'tutorial skin (SKINS.md example) works',
        skinManager.getActiveId() === 'tutorial' && engine.getState() === 'playing',
        `active=${skinManager.getActiveId()}`
      )
      await skinManager.setActive('default')
    }

    // Broken skin: unknown id must fail and leave a working skin behind.
    let threw = false
    try {
      await skinManager.setActive('no-such-skin')
    } catch {
      threw = true
    }
    check(
      'unknown skin rejected, default restored',
      threw && skinManager.getActiveId() === 'default' && engine.getState() === 'playing'
    )

    // ---- M4: Butterchurn visualizer -----------------------------------------
    await vizHost.catalog.load()
    const presetCount = vizHost.listPresets().length
    check('preset catalog loaded', presetCount > 50, `${presetCount} presets`)
    check(
      'butterchurn is active visualizer',
      vizHost.getActiveVisualizerId() === 'butterchurn',
      vizHost.getActiveVisualizerId()
    )

    const framesBefore = vizHost.getDebugInfo().frameCount
    await sleep(700)
    const framesAfter = vizHost.getDebugInfo().frameCount
    check('render loop advancing', framesAfter > framesBefore + 10, `${framesBefore} → ${framesAfter} frames`)

    // The mini-view overlay must sit exactly on the skin's canvas, or the
    // visualizer/video would render off-screen.
    const rectMatch = vizHost.debugSurfaceMatchesAnchor()
    check(
      'mini surface aligned to skin canvas',
      rectMatch !== null && rectMatch.ok,
      rectMatch?.detail ?? 'no surface'
    )

    const targetPreset = vizHost.listPresets()[Math.floor(presetCount / 2)]
    vizHost.loadPreset(targetPreset.id, 0)
    await sleep(400)
    const dbg = vizHost.getDebugInfo()
    check(
      'preset loads without error',
      dbg.presetId === targetPreset.id && dbg.lastPresetError === null,
      `${targetPreset.name}${dbg.lastPresetError ? ` — ${dbg.lastPresetError}` : ''}`
    )
    const framesBefore2 = vizHost.getDebugInfo().frameCount
    await sleep(500)
    check(
      'render survives preset switch',
      vizHost.getDebugInfo().frameCount > framesBefore2 + 5,
      `${vizHost.getDebugInfo().frameCount - framesBefore2} frames`
    )

    // ---- spectrum bars must get a real 2D context (the canvas-poisoning bug) --
    check(
      'butterchurn canvas is WebGL',
      vizHost.debugCanvasContext() === 'webgl',
      vizHost.debugCanvasContext()
    )
    await vizHost.setActiveVisualizer('bars')
    await sleep(500)
    check(
      'spectrum bars gets a 2D canvas + renders',
      vizHost.debugCanvasContext() === '2d' && vizHost.getActiveVisualizerId() === 'bars',
      `context=${vizHost.debugCanvasContext()}`
    )
    const barsFrames = vizHost.getDebugInfo().frameCount
    await sleep(400)
    check('bars render loop advancing', vizHost.getDebugInfo().frameCount > barsFrames + 5)
    await vizHost.setActiveVisualizer('butterchurn')
    await sleep(400)

    // ---- single click in fullscreen changes the preset ------------------------
    await vizHost.setFullscreen(true)
    await sleep(500)
    const fsPresetBefore = vizHost.getCurrentPresetId()
    vizHost.debugClickSurface() // simulate a user click on the fullscreen surface
    await sleep(400)
    check(
      'fullscreen single-click changes preset',
      vizHost.getCurrentPresetId() !== fsPresetBefore,
      `${fsPresetBefore} → ${vizHost.getCurrentPresetId()}`
    )
    await vizHost.setFullscreen(false)
    await sleep(400)

    // ---- viz pop-out window ----------------------------------------------------
    vizHost.popOut()
    await sleep(1500)
    check('viz pops out', vizHost.isPoppedOut())
    const popFrames = vizHost.getDebugInfo().frameCount
    await sleep(700)
    check(
      'popout keeps rendering',
      vizHost.getDebugInfo().frameCount > popFrames + 10,
      `${vizHost.getDebugInfo().frameCount - popFrames} frames`
    )
    check('audio unaffected by popout', engine.getState() === 'playing')

    vizHost.closePopout()
    await sleep(1200)
    const backFrames = vizHost.getDebugInfo().frameCount
    await sleep(700)
    check(
      'popout closes and viz returns to skin',
      !vizHost.isPoppedOut() && vizHost.getDebugInfo().frameCount > backFrames + 10,
      `${vizHost.getDebugInfo().frameCount - backFrames} frames after return`
    )

    // ---- M6: playlist export/import round-trip -------------------------------
    const exportTarget = path.replace(/[^\\/]+$/, 'selftest-export.m3u8')
    const beforeTracks = controller.model.getTracks()
    await native.invoke(
      'playlist:export',
      {
        id: 'st',
        name: 'st',
        tracks: beforeTracks,
        createdAt: 0,
        updatedAt: 0
      },
      exportTarget,
      'm3u8',
      true // relative paths — round-trip must survive them
    )
    const reimported = await native.invoke('playlist:import', exportTarget)
    check(
      'm3u8 round-trip preserves paths',
      reimported.entries.length === beforeTracks.length &&
        reimported.entries.every((e, i) => e.path === beforeTracks[i].path && !e.missing),
      `${reimported.entries.length} entries`
    )
    const importedName = await controller.importPlaylistFile(exportTarget)
    check(
      'importPlaylistFile replaces current playlist',
      importedName === 'selftest-export' && controller.model.size() === beforeTracks.length,
      `name=${importedName} size=${controller.model.size()}`
    )

    // ---- convert (right-click ▸ Convert) -------------------------------------
    const formats = await native.invoke('convert:list', false)
    check('convert offers audio formats', formats.length >= 5 && formats.some((f) => f.id === 'flac'))
    const srcTrack = controller.model.getTracks().find((t) => !t.isRemote && !t.missing)
    if (srcTrack) {
      const outPath = await controller.convertTrack(srcTrack, 'flac')
      check(
        'convert to FLAC saves a file',
        typeof outPath === 'string' && /Converted[\\/].+\.flac$/i.test(outPath!),
        outPath ?? 'null'
      )
      if (outPath) {
        const [probed] = await native.invoke('media:probe', [outPath])
        check(
          'converted file is valid',
          probed.ok && probed.durationSec > 0 && /flac/i.test(probed.codec),
          `codec=${probed.codec} dur=${probed.durationSec.toFixed(1)}s`
        )
      }
    }

    // ---- saved playlists (save / overwrite-by-id / list / get / delete) ------
    const plId = 'selftest-pl'
    const mkPl = (name: string) => ({
      id: plId,
      name,
      tracks: controller.model.getTracks(),
      createdAt: 0,
      updatedAt: 1
    })
    await native.invoke('store:playlists:save', mkPl('SelfTest PL'))
    let pls = await native.invoke('store:playlists:list')
    check('saved playlist appears in list', pls.some((p) => p.id === plId && p.name === 'SelfTest PL'))
    // Overwrite the same id with a new name — must replace, not duplicate.
    await native.invoke('store:playlists:save', mkPl('SelfTest PL v2'))
    pls = await native.invoke('store:playlists:list')
    const mine = pls.filter((p) => p.id === plId)
    check(
      'overwrite keeps one entry + updates it',
      mine.length === 1 && mine[0].name === 'SelfTest PL v2',
      `count=${mine.length} name=${mine[0]?.name}`
    )
    const loaded = await native.invoke('store:playlists:get', plId)
    check('saved playlist loads back with its tracks', loaded.tracks.length === controller.model.size())
    await native.invoke('store:playlists:delete', plId)
    pls = await native.invoke('store:playlists:list')
    check('saved playlist deletes', !pls.some((p) => p.id === plId))

    // ---- addon framework -----------------------------------------------------
    // Addon-owned visualizer plugins list like built-ins but are removed by
    // addon teardown (not skin teardown), and built-ins survive.
    const stub: VisualizerPlugin = {
      id: 'selftest-addon-viz',
      name: 'Self-test Addon Viz',
      init: () => {},
      render: () => {},
      resize: () => {},
      destroy: () => {}
    }
    vizHost.registry.register(stub, 'addon:selftest')
    check(
      'addon plugin registers + lists',
      vizHost.listVisualizers().some((v) => v.id === 'selftest-addon-viz')
    )
    const removed = vizHost.registry.removeAddonOwned('selftest')
    check(
      'addon teardown removes only its plugins',
      removed.includes('selftest-addon-viz') &&
        !vizHost.listVisualizers().some((v) => v.id === 'selftest-addon-viz') &&
        vizHost.listVisualizers().some((v) => v.id === 'butterchurn'),
      `removed=[${removed.join(',')}]`
    )

    const installedAddons = await native.invoke('addons:list')
    check('addons:list returns an array', Array.isArray(installedAddons))
    const catalog = await native.invoke('addons:catalog')
    check(
      'addons:catalog returns a shape (repo may be offline)',
      Array.isArray(catalog.addons),
      catalog.catalogError ? `catalogError: ${catalog.catalogError}` : `${catalog.addons.length} listed`
    )

    // ---- system-audio mode ---------------------------------------------------
    // We can't drive real loopback here (needs another app playing + a gesture),
    // but the state machine must start clean and tolerate a redundant disable.
    if (systemAudio) {
      check('system audio starts disabled', systemAudio.isEnabled() === false)
      systemAudio.disable()
      check('system audio disable() is a safe no-op when off', systemAudio.isEnabled() === false)
    }
    // The source-change path (used on every system-audio toggle) must re-init
    // the active visualizer cleanly — this is how Butterchurn re-taps the
    // swapped audio. Verify with butterchurn active.
    if (vizHost.getActiveVisualizerId() !== 'butterchurn') {
      await vizHost.setActiveVisualizer('butterchurn')
      await sleep(300)
    }
    const framesBeforeRefresh = vizHost.getDebugInfo().frameCount
    await vizHost.refreshForSourceChange()
    await sleep(500)
    check(
      'visualizer re-inits cleanly on audio-source change',
      vizHost.getDebugInfo().frameCount > framesBeforeRefresh + 5 &&
        vizHost.getDebugInfo().lastPresetError === null,
      `+${vizHost.getDebugInfo().frameCount - framesBeforeRefresh} frames`
    )
  } catch (err) {
    failed = true
    results.push(`FAIL  self-test threw: ${(err as Error).message}`)
  }

  await finish()

  async function finish(): Promise<void> {
    await native.invoke(
      'dev:log',
      `\n===== AMPWIN SELF-TEST (${path}) =====\n${results.join('\n')}\n===== ${failed ? 'FAILED' : 'ALL PASS'} =====`
    )
    await native.invoke('window:close')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function runEmbedTest(
  vizHost: VisualizerHost,
  check: (name: string, ok: boolean, detail?: string) => void
): Promise<void> {
  try {
    // Subscribe BEFORE showEmbed so we catch the initial state emit that lets
    // the skin drop its loading spinner.
    let gotInitialState = false
    let gotLiveData = false // real currentTime/duration only comes via postMessage
    const off = vizHost.events.on('videoState', (s) => {
      gotInitialState = true
      if (s.duration > 0) gotLiveData = true
    })

    // "Me at the zoo" — always available; embeddable.
    vizHost.showEmbed('jNQXAC9IVRw', { volume: 0.4 })
    await sleep(300)
    check('embed mode active', vizHost.getDebugInfo().mode === 'embed', vizHost.getDebugInfo().mode)
    check('embed emits a playable state (skin leaves loading)', gotInitialState)

    // The real question: did YouTube's player actually load in the iframe?
    let loaded = false
    let waited = 0
    while (!loaded && waited < 10000) {
      await sleep(500)
      waited += 500
      loaded = vizHost.debugEmbedLoaded()
    }
    check('YouTube player loaded in the embed', loaded, `after ${(waited / 1000).toFixed(1)}s`)

    // postMessage transport sync is best-effort from a file:// origin — record
    // whether it worked but don't fail on it (the embed plays regardless).
    off()
    void native.invoke('dev:log', `[embed] transport-sync=${gotLiveData} loaded=${loaded}`)

    vizHost.returnToVisualizer()
    await sleep(400)
    check('embed tears down back to visualizer', vizHost.getDebugInfo().mode === 'viz')
    await sleep(400)
    check(
      'visualizer renders again after embed',
      vizHost.getDebugInfo().mode === 'viz' && vizHost.debugCanvasContext() !== 'none'
    )
  } catch (err) {
    check('embed test threw', false, (err as Error).message)
  }
}

async function runStemsTest(
  check: (name: string, ok: boolean, detail?: string) => void
): Promise<void> {
  const src = 'C:\\Users\\Kenny\\source\\Claude\\Ampwin\\test-media\\tone.flac'
  const pack = {
    id: 'htdemucs-6s',
    label: 'HTDemucs 6s',
    kind: 'single' as const,
    sources: ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'],
    files: [
      {
        url: 'https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx',
        file: 'htdemucs_6s_fp16weights.onnx'
      }
    ]
  }
  try {
    let lastPhase = ''
    const off = native.on('evt:stems-progress', ({ progress }) => {
      if (progress.phase !== lastPhase) {
        lastPhase = progress.phase
        void native.invoke('dev:log', `[stems-test] phase=${progress.phase} ${progress.detail ?? ''}`)
      }
    })
    const t0 = performance.now()
    const result = await native.invoke('stems:separate', src, pack, {
      useGpu: true,
      force: false,
      jobKey: 'selftest'
    })
    off()
    const secs = ((performance.now() - t0) / 1000).toFixed(1)
    check(
      'separation produced all 6 stems',
      pack.sources.every((s) => !!result.stems[s]?.path && !!result.stems[s]?.url),
      `${secs}s fromCache=${result.fromCache}`
    )

    // The stem WAVs must be valid audio of the source's length (30 s tone).
    const [probe] = await native.invoke('media:probe', [result.stems['vocals'].path])
    check(
      'stem wav is valid audio (~30s)',
      probe.ok && Math.abs(probe.durationSec - 30) < 1.5,
      `dur=${probe.durationSec.toFixed(1)}s codec=${probe.codec}`
    )

    // Preview URL is fetchable (what the <audio> elements in the window use).
    const res = await fetch(result.stems['drums'].url)
    check('stem preview url streams', res.status === 200, `HTTP ${res.status}`)

    // Export both encode paths.
    const mp3 = await native.invoke('stems:export', result.stems['vocals'].path, 'mp3', 'selftest-song', 'vocals')
    const flac = await native.invoke('stems:export', result.stems['bass'].path, 'flac', 'selftest-song', 'bass')
    check('export mp3 + flac', /vocals\.mp3$/.test(mp3.path) && /bass\.flac$/.test(flac.path), mp3.path)
    const [p2] = await native.invoke('media:probe', [mp3.path])
    check('exported mp3 is valid', p2.ok && p2.durationSec > 28, `dur=${p2.durationSec.toFixed(1)}s`)

    // Mix (karaokefy's instrumental): sum 3 stems → one valid ~30s WAV.
    const mix = await native.invoke('stems:mix', [result.stems['drums'].path, result.stems['bass'].path, result.stems['other'].path], 'selftest-instrumental')
    check('mixStems returns a path + url', /\.wav$/i.test(mix.path) && /^ampwin:/.test(mix.url), mix.path)
    const [pmix] = await native.invoke('media:probe', [mix.path])
    check('mixed instrumental is valid audio (~30s)', pmix.ok && Math.abs(pmix.durationSec - 30) < 1.5, `dur=${pmix.durationSec.toFixed(1)}s`)

    // Cache: a second run must return instantly from cache.
    const t1 = performance.now()
    const again = await native.invoke('stems:separate', src, pack, {
      useGpu: true,
      force: false,
      jobKey: 'selftest2'
    })
    check(
      'second run served from cache',
      again.fromCache && performance.now() - t1 < 3000,
      `${((performance.now() - t1) / 1000).toFixed(2)}s`
    )

    // Cancel: cancel once the separate phase is actually running (as a user
    // would from the visible progress bar) and confirm it aborts within a chunk.
    const cancelKey = 'selftest-cancel'
    let separating = false
    const offc = native.on('evt:stems-progress', ({ jobKey, progress }) => {
      if (jobKey === cancelKey && progress.phase === 'separate') separating = true
    })
    const pending = native.invoke('stems:separate', src, pack, {
      useGpu: false,
      force: true,
      jobKey: cancelKey
    })
    let w = 0
    while (!separating && w < 20000) {
      await sleep(200)
      w += 200
    }
    const tc = performance.now()
    void native.invoke('stems:cancel', cancelKey)
    let cancelledOk = false
    try {
      await pending
    } catch (e) {
      cancelledOk = /cancel/i.test((e as Error).message)
    }
    offc()
    // A single session.run() is atomic (can't be interrupted mid-flight), so
    // worst-case latency is one chunk — ~5s on CPU, ~1-2s on GPU. Well under
    // the ~35s a full run would take, so this proves cancel actually aborts.
    check(
      'separation cancels once running (aborts within a chunk)',
      cancelledOk && performance.now() - tc < 9000,
      `${((performance.now() - tc) / 1000).toFixed(1)}s to abort after cancel`
    )

    // Fast single-file htdemucs (what the v4 addon now defaults to) — one pass,
    // 4 stems. Downloads a 158 MB model on first run.
    const fastPack = {
      id: 'htdemucs',
      label: 'HTDemucs v4 (fast)',
      kind: 'single' as const,
      sources: ['drums', 'bass', 'other', 'vocals'],
      files: [
        {
          url: 'https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx',
          file: 'htdemucs_fp16weights.onnx'
        }
      ]
    }
    const ft0 = performance.now()
    const fast = await native.invoke('stems:separate', src, fastPack, {
      useGpu: false,
      force: false,
      jobKey: 'selftest-fast'
    })
    check(
      'single htdemucs (fast) produces 4 stems',
      fastPack.sources.every((s) => !!fast.stems[s]?.path),
      `${((performance.now() - ft0) / 1000).toFixed(1)}s`
    )
    const [fp] = await native.invoke('media:probe', [fast.stems['vocals'].path])
    check('fast-model stem is valid audio (~30s)', fp.ok && Math.abs(fp.durationSec - 30) < 1.5, `dur=${fp.durationSec.toFixed(1)}s`)
  } catch (err) {
    check('stems test threw', false, (err as Error).message)
  }
}

function runEqTest(eq: Equalizer | undefined, check: (name: string, ok: boolean, detail?: string) => void): void {
  if (!eq) {
    check('eq available', false, 'no equalizer passed to self-test')
    return
  }
  const target = [6, -6, 3, 0, -3, 4, -4, 2, -2, 5]
  eq.setEnabled(true)
  eq.setGains(target)
  const applied = eq.debugFilterGains()
  check(
    'enabled EQ applies band gains to the biquads',
    applied.length === target.length && applied.every((g, i) => Math.abs(g - target[i]) < 0.001),
    `applied=[${applied.map((g) => g.toFixed(0)).join(',')}]`
  )
  check('gains round-trip through getGains', eq.getGains().every((g, i) => g === target[i]))

  eq.setEnabled(false)
  const off = eq.debugFilterGains()
  check('disabled EQ is transparent (all 0 dB)', off.every((g) => g === 0), `off=[${off.map((g) => g.toFixed(0)).join(',')}]`)
  // The stored gains are preserved even while bypassed.
  check('bypass keeps stored gains', eq.getGains().every((g, i) => g === target[i]))

  eq.setEnabled(true)
  eq.reset()
  check(
    'reset flattens bands + preamp',
    eq.debugFilterGains().every((g) => g === 0) && eq.getPreamp() === 0
  )
  // Clamping to the ±12 dB range.
  eq.setGain(0, 999)
  check('gains clamp to range', eq.getGains()[0] === 12, `band0=${eq.getGains()[0]}`)
  eq.reset()
  eq.setEnabled(false)
}

async function runOnlineLyricsTest(
  check: (name: string, ok: boolean, detail?: string) => void
): Promise<void> {
  try {
    const q = { artist: 'Bob Marley', title: 'No Woman No Cry', durationSec: 431 }
    const found = await native.invoke('lyrics:fetch-online', q)
    check('LRCLIB returned lyrics', !!found && found.lines.length > 3, found ? `${found.lines.length} lines synced=${found.synced}` : 'null')
    if (found) {
      check(
        'lyrics are synced (timestamps present)',
        found.synced && found.lines.every((l) => typeof l.timeMs === 'number'),
        `first=${found.lines[0]?.timeMs}ms "${found.lines[0]?.text}"`
      )
      const joined = found.lines.map((l) => l.text).join(' ').toLowerCase()
      check('lyrics contain the chorus', /no,?\s*woman/.test(joined), joined.slice(0, 60))
    }
    // Second call should hit the userData cache and match.
    const again = await native.invoke('lyrics:fetch-online', q)
    check('cached fetch returns the same lyrics', !!again && again.lines.length === (found?.lines.length ?? -1))

    // Full sidecar round-trip: write <audio>.lrc next to a real audio file, then
    // probe that file and confirm the app reads the lyrics from the sidecar
    // (exactly how a played karaoke track shows lyrics).
    if (found) {
      const audio = 'C:\\Users\\Kenny\\source\\Claude\\Ampwin\\test-media\\jfk.wav'
      const { path: lrcPath } = await native.invoke('lyrics:write-sidecar', audio, found.lines)
      check('writeSidecar writes a matching-basename .lrc next to the file', /jfk\.lrc$/i.test(lrcPath), lrcPath)
      const [probe] = await native.invoke('media:probe', [audio])
      check(
        'probe reads the sidecar → track shows synced lyrics',
        probe.lyrics?.source === 'lrc' && probe.lyrics?.synced === true && (probe.lyrics.lines.length ?? 0) > 3,
        `source=${probe.lyrics?.source} synced=${probe.lyrics?.synced} lines=${probe.lyrics?.lines.length}`
      )
    }
  } catch (err) {
    check('online lyrics test threw', false, (err as Error).message)
  }
}

async function runLyricsTest(
  vizHost: VisualizerHost,
  check: (name: string, ok: boolean, detail?: string) => void
): Promise<void> {
  try {
    const ids = vizHost.listVisualizers().map((v) => v.id)
    check('black screen visualizer registered', ids.includes('black'), ids.join(','))
    await vizHost.setActiveVisualizer('black')
    await sleep(300)
    check(
      'black screen active on a 2D canvas',
      vizHost.getActiveVisualizerId() === 'black' && vizHost.debugCanvasContext() === '2d',
      `context=${vizHost.debugCanvasContext()}`
    )

    const lyrics: Lyrics = {
      synced: true,
      source: 'lrc',
      lines: [
        { timeMs: 0, text: 'first line' },
        { timeMs: 1000, text: 'second line' },
        { timeMs: 2000, text: 'third line' }
      ]
    }
    vizHost.setLyricsEnabled(true)
    vizHost.setLyrics(lyrics)
    await sleep(50)
    let d = vizHost.debugLyrics()
    check('lyrics available + enabled + visible', d.available && d.enabled && d.visible, JSON.stringify(d))

    vizHost.setLyricsPosition(1500)
    await sleep(20)
    d = vizHost.debugLyrics()
    check('active line tracks position (1.5s → second line)', d.activeText === 'second line', d.activeText)

    vizHost.setLyricsPosition(2500)
    await sleep(20)
    d = vizHost.debugLyrics()
    check('active line advances (2.5s → third line)', d.activeText === 'third line', d.activeText)

    // Off-screen bug regression: with a LONG list on a small (mini) surface, the
    // active line must sit near the vertical center — not scrolled off.
    const many: Lyrics = {
      synced: true,
      source: 'lrc',
      lines: Array.from({ length: 40 }, (_, i) => ({ timeMs: i * 1000, text: `line ${i}` }))
    }
    vizHost.setLyrics(many)
    vizHost.setLyricsPosition(25_000) // line 25, deep in the list
    await sleep(600) // let the scroll transition settle
    const g = vizHost.debugLyrics()
    check(
      'active line is centered on a small surface',
      g.viewH > 40 && g.activeCenterY >= 0 && Math.abs(g.activeCenterY - g.viewH / 2) < g.viewH * 0.2,
      `active=line 25 centerY=${g.activeCenterY.toFixed(0)} of viewH=${g.viewH} (want ~${(g.viewH / 2).toFixed(0)})`
    )

    vizHost.setLyricsEnabled(false)
    await sleep(20)
    check('toggle off hides the overlay', !vizHost.debugLyrics().visible)

    vizHost.setLyricsEnabled(true)
    vizHost.setLyrics(null)
    await sleep(20)
    check('clearing lyrics marks the track unavailable', !vizHost.debugLyrics().available)

    vizHost.pushLiveLyrics({ synced: true, source: 'live', lines: [{ timeMs: 0, text: 'live line' }] })
    await sleep(20)
    check('live lyrics source becomes available', vizHost.debugLyrics().available)
    vizHost.clearLiveLyrics()
    await sleep(20)
    check('clearLive removes the live lyrics', !vizHost.debugLyrics().available)

    await vizHost.setActiveVisualizer('butterchurn')
  } catch (err) {
    check('lyrics test threw', false, (err as Error).message)
  }
}

async function runAddonLoadTest(
  skinManager: SkinManager,
  vizHost: VisualizerHost,
  check: (name: string, ok: boolean, detail?: string) => void
): Promise<void> {
  try {
    // The addon was loaded at boot (addonHost.boot); give its iframe script a
    // moment to run window.ampwin.visualizer.registerPlugin().
    await sleep(600)
    const listed = vizHost.listVisualizers().map((v) => v.id)
    check('addon visualizer registered from iframe', listed.includes('oscilloscope'), listed.join(','))

    if (listed.includes('oscilloscope')) {
      await vizHost.setActiveVisualizer('oscilloscope')
      await sleep(500)
      check(
        'oscilloscope active on a 2D canvas',
        vizHost.getActiveVisualizerId() === 'oscilloscope' && vizHost.debugCanvasContext() === '2d',
        `context=${vizHost.debugCanvasContext()}`
      )
      const f = vizHost.getDebugInfo().frameCount
      await sleep(500)
      check('oscilloscope render loop advancing', vizHost.getDebugInfo().frameCount > f + 5)

      // Addon-owned plugins outlive skin switches (unlike skin-owned ones).
      await skinManager.setActive('lite')
      await sleep(400)
      check(
        'addon visualizer survives a skin switch',
        vizHost.listVisualizers().some((v) => v.id === 'oscilloscope')
      )
      await skinManager.setActive('default')
    }
  } catch (err) {
    check('addon load test threw', false, (err as Error).message)
  }
}

async function runYtTest(
  controller: PlayerController,
  check: (name: string, ok: boolean, detail?: string) => void
): Promise<void> {
  // "Me at the zoo" — the first & most stable YouTube video.
  const STABLE_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
  try {
    const ensured = await native.invoke('ytdlp:ensure')
    check('yt-dlp downloads/present', ensured.ok, ensured.error ?? '')
    check('yt-dlp status installed', (await native.invoke('ytdlp:status')).installed)

    const results = await native.invoke('yt:search', 'lofi hip hop')
    check(
      'youtube search returns results',
      results.length > 0 && !!results[0].title && results[0].url.includes('youtube'),
      `${results.length} results; first="${results[0]?.title?.slice(0, 40)}"`
    )

    const probe = await native.invoke('link:probe', STABLE_URL, true)
    check(
      'link probe (audio-only) reads metadata',
      probe.ok && probe.durationSec > 0 && !probe.isVideo,
      `title="${probe.title.slice(0, 30)}" dur=${probe.durationSec}s`
    )

    const resolved = await native.invoke('link:resolve', STABLE_URL, true)
    check(
      'link resolves to a stream url',
      /^https:\/\//.test(resolved.streamUrl),
      resolved.streamUrl.slice(0, 50)
    )

    // Full end-to-end: add as a remote audio track and confirm it plays.
    controller.stop()
    controller.model.replaceAll([], -1)
    const track = await controller.addLink(STABLE_URL, true)
    check('addLink creates a remote track', !!track && !!track.isRemote)
    await controller.playIndex(0)
    let waited = 0
    while (controller.getSnapshot().state !== 'playing' && waited < 15000) {
      await sleep(500)
      waited += 500
    }
    check(
      'youtube audio actually plays',
      controller.getSnapshot().state === 'playing',
      `state=${controller.getSnapshot().state} after ${(waited / 1000).toFixed(1)}s`
    )
    controller.stop()

    // Download: audio (m4a) and audio+video (mp4). The finished files must be
    // added to the playlist as local, playable tracks.
    const remote = controller.model.getCurrentTrack() ?? controller.model.trackAt(0)!
    const beforeCount = controller.model.size()
    const dlAudio = await controller.downloadTrack(remote, 'audio')
    check(
      'download audio (m4a) → local track',
      !!dlAudio && !dlAudio.isRemote && /\.m4a$/i.test(dlAudio.path) && dlAudio.durationSec > 0,
      dlAudio ? `${dlAudio.path.split(/[\\/]/).pop()} dur=${dlAudio.durationSec}s` : 'null'
    )
    const dlBoth = await controller.downloadTrack(remote, 'both')
    check(
      'download audio+video (mp4) → local video track',
      !!dlBoth && !dlBoth.isRemote && /\.mp4$/i.test(dlBoth.path) && dlBoth.isVideo,
      dlBoth ? `${dlBoth.path.split(/[\\/]/).pop()} video=${dlBoth.isVideo}` : 'null'
    )
    check('downloads added to playlist', controller.model.size() === beforeCount + 2)
    // The downloaded audio file must actually play locally.
    const audioIdx = controller.model.getTracks().findIndex((t) => t.id === dlAudio?.id)
    await controller.playIndex(audioIdx)
    let w2 = 0
    while (controller.getSnapshot().state !== 'playing' && w2 < 6000) {
      await sleep(300)
      w2 += 300
    }
    check('downloaded audio plays locally', controller.getSnapshot().state === 'playing')
    controller.stop()
  } catch (err) {
    check('yt test threw', false, (err as Error).message)
  }
}
