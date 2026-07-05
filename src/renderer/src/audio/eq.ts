// 10-band graphic equalizer built from Web Audio peaking BiquadFilters — a
// realtime, zero-latency EQ on the app's own playback (ffmpeg EQ would mean
// re-encoding, i.e. not live). A preamp GainNode sits in front. When disabled,
// every peaking filter sits at 0 dB (transparent) and the preamp at unity.
//
// Chain: input(preamp) → band0 → band1 → … → band9 → output
// Inserted between the graph's mixerGain and masterGain (see graph.ts).

export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
export const EQ_MIN_DB = -12
export const EQ_MAX_DB = 12
// ~1-octave bandwidth so adjacent bands overlap smoothly.
const EQ_Q = 1.41

export interface EqState {
  enabled: boolean
  preamp: number
  bands: number[]
}

const clampDb = (db: number): number => Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, Number.isFinite(db) ? db : 0))

export class Equalizer {
  /** Feed playback in here. */
  readonly input: GainNode
  /** Connect this to the rest of the graph. */
  readonly output: GainNode

  private ctx: AudioContext
  private preamp: GainNode
  private filters: BiquadFilterNode[]
  private enabled = false
  private gains: number[]
  private preampDb = 0

  constructor(ctx: AudioContext) {
    this.ctx = ctx
    this.preamp = ctx.createGain()
    this.input = this.preamp
    this.output = ctx.createGain()
    this.filters = EQ_FREQS.map((f) => {
      const b = ctx.createBiquadFilter()
      b.type = 'peaking'
      b.frequency.value = f
      b.Q.value = EQ_Q
      b.gain.value = 0
      return b
    })
    let node: AudioNode = this.preamp
    for (const f of this.filters) {
      node.connect(f)
      node = f
    }
    node.connect(this.output)
    this.gains = new Array(EQ_FREQS.length).fill(0)
  }

  private applyPreamp(): void {
    const target = this.enabled ? Math.pow(10, this.preampDb / 20) : 1
    // Smooth the GainNode (prone to clicks); biquad gains are set directly.
    try {
      this.preamp.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02)
    } catch {
      this.preamp.gain.value = target
    }
  }

  private apply(): void {
    for (let i = 0; i < this.filters.length; i++) {
      this.filters[i].gain.value = this.enabled ? this.gains[i] : 0
    }
    this.applyPreamp()
  }

  /** Restore from persisted settings and apply. */
  load(state?: Partial<EqState>): void {
    if (state) {
      if (typeof state.enabled === 'boolean') this.enabled = state.enabled
      if (typeof state.preamp === 'number') this.preampDb = clampDb(state.preamp)
      if (Array.isArray(state.bands)) {
        for (let i = 0; i < this.gains.length; i++) this.gains[i] = clampDb(state.bands[i] ?? 0)
      }
    }
    this.apply()
  }

  isEnabled(): boolean {
    return this.enabled
  }
  setEnabled(on: boolean): void {
    this.enabled = on
    this.apply()
  }

  getGains(): number[] {
    return this.gains.slice()
  }
  setGain(i: number, db: number): void {
    if (i < 0 || i >= this.gains.length) return
    this.gains[i] = clampDb(db)
    if (this.enabled) this.filters[i].gain.value = this.gains[i]
  }
  setGains(arr: number[]): void {
    for (let i = 0; i < this.gains.length; i++) this.gains[i] = clampDb(arr[i] ?? 0)
    this.apply()
  }

  getPreamp(): number {
    return this.preampDb
  }
  setPreamp(db: number): void {
    this.preampDb = clampDb(db)
    if (this.enabled) this.applyPreamp()
  }

  reset(): void {
    this.gains.fill(0)
    this.preampDb = 0
    this.apply()
  }

  state(): EqState {
    return { enabled: this.enabled, preamp: this.preampDb, bands: this.gains.slice() }
  }

  /** Test hook: the biquad gains actually applied right now. */
  debugFilterGains(): number[] {
    return this.filters.map((f) => f.gain.value)
  }
}
