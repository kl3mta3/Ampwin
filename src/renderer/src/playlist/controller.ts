// Glue between the audio engine and the playlist model: advance-on-end,
// error skipping, next-track preload, session + settings persistence.
// This is the object the skin API facade will wrap in M3.

import type { PlayerSnapshot, PlayState, RepeatMode, Track, TrackProbe } from '../../../shared/types'
import { native } from '../native'
import { Emitter } from '../emitter'
import { AudioEngine } from '../audio/engine'
import type { VisualizerHost, VideoState } from '../viz/host'
import { PlaylistModel } from './model'

const PRELOAD_AHEAD_SEC = 15
const MAX_CONSECUTIVE_ERRORS = 3

interface ControllerEvents extends Record<string, unknown[]> {
  track: [Track | null]
  error: [message: string, track: Track | null]
  /** Unified across audio engine and video window — skins subscribe to these. */
  state: [PlayState]
  position: [posSec: number, durSec: number]
  volume: [v: number, muted: boolean]
}

export function trackFromProbe(p: TrackProbe): Track {
  return {
    id: crypto.randomUUID(),
    path: p.path,
    title: p.title,
    artist: p.artist,
    album: p.album,
    durationSec: p.durationSec,
    codec: p.codec,
    verdict: p.verdict === 'transcode' ? 'transcode' : 'native',
    isVideo: p.isVideo,
    mtimeMs: p.mtimeMs,
    missing: !p.ok && !p.unreadable,
    unreadable: p.unreadable
  }
}

export class PlayerController {
  readonly events = new Emitter<ControllerEvents>()
  readonly model = new PlaylistModel()
  readonly engine: AudioEngine

  private consecutiveErrors = 0
  private saveTimer: number | null = null
  private restoring = false
  /** Tracks already retried through the ffmpeg path after a native failure. */
  private transcodeRetried = new Set<string>()
  private loadingPercent: number | undefined

  constructor(engine: AudioEngine) {
    this.engine = engine

    engine.events.on('ended', () => this.advance(true))

    engine.events.on('error', (msg) => {
      const track = this.model.getCurrentTrack()

      // Safety net: a "native" verdict can still fail (mislabeled codec).
      // Retry once through the ffmpeg transcode path before skipping (local files only).
      if (track && !track.missing && !track.isRemote && track.verdict === 'native' && !this.transcodeRetried.has(track.id)) {
        this.transcodeRetried.add(track.id)
        void this.engine.load(track.path, { autoplay: true, forceTranscode: true })
        return
      }

      this.events.emit('error', msg, track)
      this.consecutiveErrors++
      if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        // Don't machine-gun through a broken playlist.
        this.engine.stop()
        this.events.emit('error', `stopped after ${MAX_CONSECUTIVE_ERRORS} consecutive failures`, null)
        return
      }
      this.advance(true)
    })

    native.on('evt:prepare-progress', ({ path, percent }) => {
      const track = this.model.getCurrentTrack()
      const loading = this.videoMode
        ? this.lastVideoState === 'loading'
        : this.engine.getState() === 'loading'
      if (track && track.path === path && loading) {
        this.loadingPercent = Math.round(percent)
      }
    })

    engine.events.on('state', (s) => {
      if (s !== 'loading') this.loadingPercent = undefined
    })

    engine.events.on('position', (pos, dur) => {
      this.maybePreloadNext(pos, dur)
      this.scheduleSessionSave()
      if (!this.videoMode) this.events.emit('position', pos, dur)
    })

    engine.events.on('state', (s) => {
      if (s === 'playing') this.consecutiveErrors = 0
      if (!this.videoMode) this.events.emit('state', s)
    })

    this.model.events.on('changed', () => this.scheduleSessionSave())

    // Debounced saves can be up to 2s stale — flush the real position on exit.
    window.addEventListener('beforeunload', () => {
      native.flushSession({
        tracks: this.model.getTracks(),
        currentIndex: this.model.getCurrentIndex(),
        positionSec: this.engine.getPosition()
      })
    })
  }

  // ---- video-on-visualizer-surface integration -----------------------------
  // Video plays on the visualizer host's surface (mini view / pop-out /
  // fullscreen), not a separate window. The controller routes transport to the
  // host's <video> and mirrors its state onto the same player events audio uses.

  private vizHost: VisualizerHost | null = null
  private videoMode = false
  private lastVideoState: PlayState = 'idle'
  private videoState: VideoState | null = null

  attachVizHost(host: VisualizerHost): void {
    this.vizHost = host

    host.events.on('videoState', (s) => {
      if (!this.videoMode) return
      this.videoState = s
      if (s.playing) this.consecutiveErrors = 0
      const state: PlayState = s.playing ? 'playing' : 'paused'
      if (state !== this.lastVideoState) {
        this.lastVideoState = state
        this.loadingPercent = undefined
        this.events.emit('state', state)
      }
      this.events.emit('position', s.position, s.duration)
      this.scheduleSessionSave()
    })

    host.events.on('videoEnded', () => {
      if (this.videoMode) void this.advance(true)
    })

    host.events.on('videoError', (msg) => {
      if (!this.videoMode) return
      const track = this.model.getCurrentTrack()
      this.events.emit('error', `video: ${msg}`, track)
      this.consecutiveErrors++
      if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        this.stop()
        this.events.emit('error', `stopped after ${MAX_CONSECUTIVE_ERRORS} consecutive failures`, null)
        return
      }
      void this.advance(true)
    })
  }

  /** Perceptual video volume matching the audio engine's masterGain curve. */
  private videoVolume(): number {
    return this.engine.getMuted() ? 0 : this.engine.getVolume() ** 2
  }

  private enterVideoMode(): void {
    this.engine.stop()
    this.engine.clearPreload()
    this.videoMode = true
  }

  private exitVideoMode(): void {
    if (this.videoMode) {
      this.videoMode = false
      this.videoState = null
      this.lastVideoState = 'idle'
      this.vizHost?.returnToVisualizer()
    }
  }

  // ---- unified transport (audio engine or video surface) --------------------

  play(): void {
    if (this.videoMode) this.vizHost?.playVideo()
    else void this.engine.play()
  }

  pause(): void {
    if (this.videoMode) this.vizHost?.pauseVideo()
    else this.engine.pause()
  }

  stop(): void {
    this.exitVideoMode()
    this.engine.stop()
  }

  togglePlay(): void {
    if (this.videoMode) {
      if (this.videoState?.playing) this.vizHost?.pauseVideo()
      else this.vizHost?.playVideo()
      return
    }
    const s = this.engine.getState()
    if (s === 'playing') this.engine.pause()
    else if (s === 'paused') void this.engine.play()
    else if (this.model.size() > 0) {
      void this.playIndex(Math.max(0, this.model.getCurrentIndex()))
    }
  }

  seekTo(seconds: number): void {
    if (this.videoMode) this.vizHost?.seekVideo(seconds)
    else this.engine.seek(seconds)
  }

  // ---- playback commands -------------------------------------------------

  async playIndex(index: number): Promise<void> {
    const track = this.model.trackAt(index)
    if (!track || track.missing || track.unreadable) return
    this.model.setCurrentIndex(index)
    this.events.emit('track', track)

    // Remote link (YouTube etc.): resolve a fresh stream URL each play, since
    // resolved URLs expire. The result routes into the normal audio/video path.
    if (track.isRemote) {
      const isVideo = track.isVideo
      if (isVideo && this.vizHost) {
        if (!this.videoMode) this.enterVideoMode()
        this.lastVideoState = 'loading'
        this.videoState = { playing: false, position: 0, duration: track.durationSec }
        this.events.emit('state', 'loading')
      } else {
        this.exitVideoMode()
      }
      try {
        const { streamUrl } = await native.invoke('link:resolve', track.path, !!track.audioOnly)
        if (this.model.getCurrentTrack()?.id !== track.id) return
        if (isVideo && this.vizHost) {
          this.vizHost.showVideoStream(streamUrl, track.durationSec, {
            positionSec: 0,
            volume: this.videoVolume()
          })
        } else {
          await this.engine.load(streamUrl, { autoplay: true })
        }
      } catch (err) {
        this.exitVideoMode()
        this.events.emit('state', 'idle')
        this.events.emit('error', `link failed: ${(err as Error).message}`, track)
      }
      return
    }

    if (track.isVideo && this.vizHost) {
      if (!this.videoMode) this.enterVideoMode()
      // Brief loading state until frames flow (host videoState flips it).
      this.lastVideoState = 'loading'
      this.videoState = { playing: false, position: 0, duration: track.durationSec }
      this.events.emit('state', 'loading')
      try {
        const plan = await native.invoke('media:video-plan', track.path)
        if (!this.videoMode || this.model.getCurrentTrack()?.id !== track.id) return
        this.videoState = { playing: false, position: 0, duration: plan.durationSec || track.durationSec }
        if (plan.direct) {
          const { url } = await native.invoke('media:prepare', track.path)
          if (!this.videoMode || this.model.getCurrentTrack()?.id !== track.id) return
          this.vizHost.showVideo(url, { positionSec: 0, volume: this.videoVolume() })
        } else {
          // Progressive: starts playing immediately while ffmpeg converts
          // ahead of the playhead — no pre-conversion wait.
          this.vizHost.showVideoStream(track.path, plan.durationSec || track.durationSec, {
            positionSec: 0,
            volume: this.videoVolume()
          })
        }
      } catch (err) {
        this.exitVideoMode()
        this.events.emit('state', 'idle')
        this.events.emit('error', `video failed: ${(err as Error).message}`, track)
      }
      return
    }

    this.exitVideoMode()
    await this.engine.load(track.path, { autoplay: true })
  }

  async next(): Promise<void> {
    const idx = this.model.nextIndex(false)
    if (idx !== null) await this.playIndex(idx)
  }

  async previous(): Promise<void> {
    // Winamp behavior: early in a track, go to previous; otherwise restart.
    const pos = this.videoMode ? (this.videoState?.position ?? 0) : this.engine.getPosition()
    if (pos > 3) {
      this.seekTo(0)
      return
    }
    const idx = this.model.prevIndex()
    if (idx !== null) await this.playIndex(idx)
    else this.seekTo(0)
  }

  private async advance(forEnded: boolean): Promise<void> {
    const idx = this.model.nextIndex(forEnded)
    if (idx === null) {
      this.stop()
      this.events.emit('track', null)
      return
    }
    if (forEnded && idx === this.model.getCurrentIndex()) {
      // repeat-one: just restart
      this.seekTo(0)
      this.play()
      return
    }
    await this.playIndex(idx)
  }

  private maybePreloadNext(pos: number, dur: number): void {
    if (dur <= 0 || dur - pos > PRELOAD_AHEAD_SEC) return
    if (this.model.repeat === 'one') return
    const idx = this.model.nextIndex(true)
    if (idx === null || idx === this.model.getCurrentIndex()) return
    const nextTrack = this.model.trackAt(idx)
    if (nextTrack && !nextTrack.missing && this.engine.getPreloadedPath() !== nextTrack.path) {
      void this.engine.preloadNext(nextTrack.path)
    }
  }

  // ---- library-ish helpers -----------------------------------------------

  /** Probe paths and append as tracks; returns the created tracks. */
  async addPaths(paths: string[], atIndex?: number): Promise<Track[]> {
    if (paths.length === 0) return []
    const probes = await native.invoke('media:probe', paths)
    const tracks = probes.map(trackFromProbe)
    this.model.add(tracks, atIndex)
    return tracks
  }

  /** Download a remote track to the downloads folder and add the local file
   *  to the playlist (right after the source). Returns the new local track. */
  async downloadTrack(track: Track, kind: 'audio' | 'video' | 'both'): Promise<Track | null> {
    if (!track.isRemote) return null
    try {
      const { path } = await native.invoke('link:download', track.path, kind)
      const [probe] = await native.invoke('media:probe', [path])
      const local = trackFromProbe(probe)
      const idx = this.model.getTracks().findIndex((t) => t.id === track.id)
      this.model.add([local], idx >= 0 ? idx + 1 : undefined)
      return local
    } catch (err) {
      this.events.emit('error', `download failed: ${(err as Error).message}`, track)
      return null
    }
  }

  /** Add a URL (YouTube/site link or direct media URL) as a remote track. */
  async addLink(url: string, audioOnly: boolean): Promise<Track | null> {
    const probe = await native.invoke('link:probe', url.trim(), audioOnly)
    if (!probe.ok) {
      this.events.emit('error', `couldn't add link: ${probe.error ?? 'unknown error'}`, null)
      return null
    }
    const track: Track = {
      id: crypto.randomUUID(),
      path: url.trim(),
      title: probe.title,
      artist: probe.uploader ?? '',
      album: '',
      durationSec: probe.durationSec,
      codec: probe.needsYtDlp ? 'stream' : 'url',
      verdict: 'native',
      isVideo: probe.isVideo,
      mtimeMs: 0,
      isRemote: true,
      audioOnly
    }
    this.model.add([track])
    return track
  }

  /** Import .m3u/.m3u8/.pls: replaces the current playlist. Returns the
   *  playlist's name, or null if it contained nothing usable. */
  async importPlaylistFile(path: string): Promise<string | null> {
    const imported = await native.invoke('playlist:import', path)
    if (imported.entries.length === 0) return null
    const probes = await native.invoke(
      'media:probe',
      imported.entries.map((e) => e.path)
    )
    const tracks = probes.map((p, i) => {
      const t = trackFromProbe(p)
      const entry = imported.entries[i]
      // For missing files, the playlist's own EXTINF metadata beats a bare filename.
      if (!p.ok && entry.title) t.title = entry.title
      if (!p.ok && entry.durationSec) t.durationSec = entry.durationSec
      return t
    })
    this.engine.stop()
    const firstPlayable = tracks.findIndex((t) => !t.missing)
    this.model.replaceAll(tracks, firstPlayable)
    if (imported.skippedUrls.length > 0) {
      this.events.emit(
        'error',
        `${imported.skippedUrls.length} stream URL(s) skipped — internet radio is not supported yet`,
        null
      )
    }
    return imported.name
  }

  /** Files arriving from OS "Open with", second instance, or drag & drop. */
  async openPaths(paths: string[]): Promise<void> {
    const playlist = paths.find((p) => /\.(m3u8?|pls)$/i.test(p))
    if (playlist) {
      await this.importPlaylistFile(playlist)
      const idx = this.model.getCurrentIndex()
      if (idx >= 0) await this.playIndex(idx)
      return
    }
    const before = this.model.size()
    const added = await this.addPaths(paths)
    if (added.length > 0 && this.engine.getState() === 'idle') {
      await this.playIndex(before)
    }
  }

  // ---- mode + volume (persisted to settings) ------------------------------

  setShuffle(on: boolean): void {
    this.model.setShuffle(on)
    void native.invoke('store:settings:patch', { shuffle: on })
  }

  setRepeat(mode: RepeatMode): void {
    this.model.setRepeat(mode)
    void native.invoke('store:settings:patch', { repeat: mode })
  }

  setVolume(v: number): void {
    this.engine.setVolume(v)
    if (this.videoMode) this.vizHost?.setVideoVolume(this.videoVolume())
    this.events.emit('volume', this.engine.getVolume(), this.engine.getMuted())
    void native.invoke('store:settings:patch', { volume: v })
  }

  setMuted(m: boolean): void {
    this.engine.setMuted(m)
    if (this.videoMode) this.vizHost?.setVideoVolume(this.videoVolume())
    this.events.emit('volume', this.engine.getVolume(), this.engine.getMuted())
    void native.invoke('store:settings:patch', { muted: m })
  }

  getSnapshot(): PlayerSnapshot {
    if (this.videoMode) {
      const vs = this.videoState
      return {
        state: this.lastVideoState,
        track: this.model.getCurrentTrack(),
        positionSec: vs?.position ?? 0,
        durationSec: vs?.duration ?? 0,
        volume: this.engine.getVolume(),
        muted: this.engine.getMuted(),
        shuffle: this.model.shuffle,
        repeat: this.model.repeat,
        loadingPercent: this.loadingPercent
      }
    }
    return {
      state: this.engine.getState(),
      track: this.model.getCurrentTrack(),
      positionSec: this.engine.getPosition(),
      durationSec: this.engine.getDuration(),
      volume: this.engine.getVolume(),
      muted: this.engine.getMuted(),
      shuffle: this.model.shuffle,
      repeat: this.model.repeat,
      loadingPercent: this.loadingPercent
    }
  }

  // ---- session persistence -------------------------------------------------

  async restore(settings?: import('../../../shared/types').Settings): Promise<void> {
    this.restoring = true
    try {
      settings ??= await native.invoke('store:settings:get')
      this.engine.setVolume(settings.volume)
      this.engine.setMuted(settings.muted)
      this.model.setShuffle(settings.shuffle)
      this.model.setRepeat(settings.repeat)

      const session = await native.invoke('store:session:get')
      if (session && session.tracks.length > 0) {
        this.model.replaceAll(session.tracks, session.currentIndex)
        const track = this.model.getCurrentTrack()
        if (track) this.events.emit('track', track)
        // Only preload a plain local audio track (paused at the saved position).
        // Video/remote tracks resolve/stream on demand — loading their path into
        // the audio element would just error and skip. User presses play to start.
        if (track && !track.missing && !track.unreadable && !track.isRemote && !track.isVideo) {
          await this.engine.load(track.path, { autoplay: false })
          if (session.positionSec > 0) this.engine.seek(session.positionSec)
        }
      }
    } finally {
      this.restoring = false
    }
  }

  private scheduleSessionSave(): void {
    if (this.restoring || this.saveTimer !== null) return
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      void native.invoke('store:session:save', {
        tracks: this.model.getTracks(),
        currentIndex: this.model.getCurrentIndex(),
        positionSec: this.engine.getPosition()
      })
    }, 2000)
  }
}
