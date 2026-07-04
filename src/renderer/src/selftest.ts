// Dev-only self-test, run when AMPWIN_SELFTEST=<absolute media path>.
// Exercises probe → prepare → protocol fetch with Range → engine playback →
// seek → auto-advance. Results land in main stdout via dev:log; the app
// quits itself when done.

import { native } from './native'
import type { PlayerController } from './playlist/controller'
import type { SkinManager } from './skin/skinHost'
import type { VisualizerHost } from './viz/host'
import type { SystemAudioCapture } from './audio/systemAudio'
import type { VisualizerPlugin } from './viz/plugin'

export async function runSelfTest(
  path: string,
  controller: PlayerController,
  skinManager: SkinManager,
  vizHost: VisualizerHost,
  systemAudio?: SystemAudioCapture
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
      await sleep(1500) // let position advance before the seek test

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
