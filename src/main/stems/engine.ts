// Stem-separation engine: HTDemucs ONNX inference via onnxruntime-node.
//
// The exported graphs (StemSplitio HuggingFace repos) bake the STFT/iSTFT into
// the model, so the host only has to do what demucs itself does around the
// network: decode to stereo float32 @ 44.1 kHz, run fixed 7.8 s segments
// (343,980 samples) with quarter-segment triangular overlap-add, and divide by
// the accumulated window weight. Input tensor "mix" (1, 2, 343980) → output
// "stems" (1, S, 2, 343980), stem order per the pack's `sources`.
//
// Two pack shapes exist:
//   'single' — one .onnx emits all stems (htdemucs, htdemucs_6s).
//   'bag'    — htdemucs_ft: four specialist files, each emitting all 4 stems
//              but fine-tuned for ONE; the ensemble keeps each specialist's
//              own row (mathematically identical to the PyTorch bag).
// Bag specialists run SEQUENTIALLY (load → all chunks → release) so peak RAM
// stays ~1 model instead of 4.
//
// Everything is cached: models in userData/models/<packId>/, separated stems
// as float32 WAVs in userData/stems/<jobHash>/. Re-runs are instant unless
// force=true (the Restem button).

import { app } from 'electron'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { constants as osConstants, cpus, setPriority } from 'os'
import { createWriteStream, existsSync, promises as fsp } from 'fs'
import { dirname, join } from 'path'
import { net } from 'electron'

// Leave the OS + UI CPU headroom so a separation doesn't lock up the whole
// machine. Just under half the logical cores (min 1) keeps several cores free
// for interactive work while still finishing in reasonable time; the GPU EPs
// barely touch these. Combined with idle-class process priority below.
const CPU_THREADS = Math.max(1, Math.floor((cpus().length || 4) / 2) - 1)
import { ffmpegPath } from '../ffmpeg/paths'
import { allowMediaPath, mediaUrlFor } from '../protocol'
import type { StemModelPack, StemsProgress, StemsResult } from '../../shared/types'

const SAMPLE_RATE = 44100
const N_SAMPLES = 343980 // 7.8 s — baked into the exported graphs
const N_CHANNELS = 2
const SAFE_ID = /^[a-z0-9-]+$/
const SAFE_FILE = /^[A-Za-z0-9._-]+$/

export type ProgressFn = (p: StemsProgress) => void

function modelsDir(packId: string): string {
  return join(app.getPath('userData'), 'models', packId)
}

function stemsCacheRoot(): string {
  return join(app.getPath('userData'), 'stems')
}

export function stemsExportDir(subfolder = 'Stems'): string {
  const safe = /^[A-Za-z0-9 _-]+$/.test(subfolder) ? subfolder : 'Stems'
  return join(app.getPath('userData'), 'downloads', safe)
}

function validatePack(pack: StemModelPack): void {
  if (!SAFE_ID.test(pack.id)) throw new Error(`invalid pack id: ${pack.id}`)
  if (pack.files.length === 0) throw new Error('pack has no model files')
  for (const f of pack.files) {
    if (!SAFE_FILE.test(f.file)) throw new Error(`invalid model filename: ${f.file}`)
    if (!/^https:\/\//.test(f.url)) throw new Error(`model URL must be https: ${f.url}`)
    if (pack.kind === 'bag' && (!f.stem || !pack.sources.includes(f.stem))) {
      throw new Error(`bag file ${f.file} must name one of the pack's stems`)
    }
  }
}

// ---- model download ---------------------------------------------------------

async function downloadFile(url: string, dest: string, onPct: (pct: number) => void): Promise<void> {
  // no-store: don't mirror multi-hundred-MB model files into Electron's HTTP cache.
  const res = await net.fetch(url, { cache: 'no-store' })
  if (!res.ok || !res.body) throw new Error(`model download failed (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  let received = 0
  const tmp = `${dest}.part`
  const out = createWriteStream(tmp)
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((r) => out.once('drain', r))
      }
      if (total > 0) onPct(received / total)
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error) => (e ? reject(e) : resolve())))
  } catch (err) {
    out.destroy()
    await fsp.unlink(tmp).catch(() => {})
    throw err
  }
  await fsp.rename(tmp, dest)
}

/** Download any missing model files for the pack (with overall % progress).
 *  Returns the local paths in pack.files order. */
export async function ensureModelPack(pack: StemModelPack, onProgress: ProgressFn): Promise<string[]> {
  validatePack(pack)
  const dir = modelsDir(pack.id)
  await fsp.mkdir(dir, { recursive: true })
  const paths: string[] = []
  const missing: number[] = []
  for (let i = 0; i < pack.files.length; i++) {
    const p = join(dir, pack.files[i].file)
    paths.push(p)
    if (!existsSync(p)) missing.push(i)
  }
  for (let m = 0; m < missing.length; m++) {
    const i = missing[m]
    onProgress({
      phase: 'download',
      percent: Math.round((m / missing.length) * 100),
      detail: `downloading model ${m + 1}/${missing.length}`
    })
    await downloadFile(pack.files[i].url, paths[i], (frac) => {
      onProgress({
        phase: 'download',
        percent: Math.round(((m + frac) / missing.length) * 100),
        detail: `downloading model ${m + 1}/${missing.length}`
      })
    })
  }
  if (missing.length > 0) onProgress({ phase: 'download', percent: 100 })
  return paths
}

export async function isModelPackInstalled(pack: StemModelPack): Promise<boolean> {
  validatePack(pack)
  return pack.files.every((f) => existsSync(join(modelsDir(pack.id), f.file)))
}

// ---- audio decode / encode --------------------------------------------------

/** Decode any local media file to planar stereo float32 @ 44.1 kHz. */
async function decodeAudio(srcPath: string): Promise<[Float32Array, Float32Array]> {
  const args = ['-v', 'error', '-i', srcPath, '-vn', '-ac', '2', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-']
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { windowsHide: true })
    let errTail = ''
    proc.stdout.on('data', (d: Buffer) => chunks.push(d))
    proc.stderr.on('data', (d: Buffer) => (errTail = (errTail + d.toString()).slice(-500)))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`decode failed: ${errTail.trim().slice(-200)}`))
    })
  })
  const raw = Buffer.concat(chunks)
  const interleaved = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4))
  const n = Math.floor(interleaved.length / 2)
  if (n === 0) throw new Error('decoded no audio samples')
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    left[i] = interleaved[2 * i]
    right[i] = interleaved[2 * i + 1]
  }
  return [left, right]
}

/** Minimal float32 WAV writer (what ffmpeg/<audio> both read happily). */
async function writeWavFloat32(path: string, ch: [Float32Array, Float32Array]): Promise<void> {
  const n = ch[0].length
  const dataBytes = n * N_CHANNELS * 4
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(3, 20) // IEEE float
  buf.writeUInt16LE(N_CHANNELS, 22)
  buf.writeUInt32LE(SAMPLE_RATE, 24)
  buf.writeUInt32LE(SAMPLE_RATE * N_CHANNELS * 4, 28)
  buf.writeUInt16LE(N_CHANNELS * 4, 32)
  buf.writeUInt16LE(32, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(ch[0][i], 44 + i * 8)
    buf.writeFloatLE(ch[1][i], 48 + i * 8)
  }
  await fsp.writeFile(path, buf)
}

// ---- inference --------------------------------------------------------------

interface OrtModule {
  Tensor: new (type: string, data: Float32Array, dims: number[]) => { data: Float32Array }
  InferenceSession: {
    create(
      path: string,
      opts: {
        executionProviders: string[]
        graphOptimizationLevel?: string
        intraOpNumThreads?: number
        interOpNumThreads?: number
      }
    ): Promise<{
      run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>
      release?: () => Promise<void>
    }>
  }
}

let ortModule: OrtModule | null = null
async function loadOrt(): Promise<OrtModule> {
  if (!ortModule) {
    ortModule = (await import('onnxruntime-node')) as unknown as OrtModule
  }
  return ortModule
}

const EP_LABEL: Record<string, string> = {
  cuda: 'GPU (CUDA)',
  dml: 'GPU (DirectML)',
  cpu: 'CPU'
}

async function createSession(
  ort: OrtModule,
  modelPath: string,
  useGpu: boolean
): Promise<{ session: Awaited<ReturnType<OrtModule['InferenceSession']['create']>>; provider: string }> {
  // GPU: DirectML (any Windows GPU, no install) → CPU. NOTE: onnxruntime-node's
  // Windows binary does NOT include the CUDA execution provider ("[cuda] backend
  // not found"), so CUDA can't be added by shipping DLLs — it would need a
  // CUDA-enabled ORT build swapped in or a native/Python sidecar. Left out here
  // to avoid a guaranteed-failing attempt on every model load.
  const attempts = useGpu ? ['dml', 'cpu'] : ['cpu']
  let lastErr: unknown
  for (const ep of attempts) {
    try {
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: [ep],
        // Full optimization for every EP (verified: 'basic'/'disabled' on
        // DirectML either error on ConvTranspose or device-hang; 'all' is the
        // one that runs). On stable GPUs DirectML is a big win; on brand-new
        // silicon (e.g. RTX 50-series) DirectML 1.15.4 has no optimized kernels
        // yet — it's slower than CPU and device-hangs mid-run — so the runtime
        // fallback below drops such a job to CPU.
        graphOptimizationLevel: 'all',
        // Cap CPU threads so a separation can't peg every core and lock up the
        // machine (the responsiveness fix). ~2.7s/chunk at 8 threads.
        intraOpNumThreads: CPU_THREADS,
        interOpNumThreads: 1
      })
      return { session, provider: EP_LABEL[ep] }
    } catch (err) {
      lastErr = err
      if (ep !== 'cpu') {
        console.warn(`stems: ${ep} EP unavailable, trying next — ${(err as Error).message.slice(0, 120)}`)
      }
    }
  }
  throw lastErr
}

/** Triangular fade window for quarter-segment overlap-add (mirrors demucs). */
function transitionWindow(): Float32Array {
  const t = Math.floor(N_SAMPLES / 4)
  const w = new Float32Array(N_SAMPLES).fill(1)
  for (let i = 0; i < t; i++) {
    const v = i / (t - 1)
    w[i] = v
    w[N_SAMPLES - 1 - i] = v
  }
  return w
}

interface JobState {
  cancelled: boolean
}

const activeJobs = new Map<string, JobState>()
let running = false

export function cancelStemsJob(key: string): void {
  const j = activeJobs.get(key)
  if (j) j.cancelled = true
}

function jobHash(srcPath: string, mtimeMs: number, pack: StemModelPack): string {
  return createHash('sha1').update(`${srcPath}|${mtimeMs}|${pack.id}`).digest('hex').slice(0, 20)
}

/** Separate a local file into stems. Results are cached; force re-runs.
 *  Serialized: only one separation runs at a time (RAM + GPU pressure). */
export async function separateTrack(
  srcPath: string,
  pack: StemModelPack,
  opts: { useGpu: boolean; force: boolean; jobKey: string },
  onProgress: ProgressFn
): Promise<StemsResult> {
  validatePack(pack)
  const stat = await fsp.stat(srcPath)
  const hash = jobHash(srcPath, stat.mtimeMs, pack)
  const outDir = join(stemsCacheRoot(), hash)

  const finish = async (fromCache: boolean): Promise<StemsResult> => {
    const stems: StemsResult['stems'] = {}
    for (const s of pack.sources) {
      const p = join(outDir, `${s}.wav`)
      allowMediaPath(p)
      stems[s] = { path: p, url: mediaUrlFor(p) }
    }
    return { stems, fromCache, sampleRate: SAMPLE_RATE }
  }

  // Cache hit — everything already separated for this exact file+pack.
  if (!opts.force && pack.sources.every((s) => existsSync(join(outDir, `${s}.wav`)))) {
    return finish(true)
  }

  if (running) throw new Error('another stem separation is already running — wait for it to finish')
  running = true
  const job: JobState = { cancelled: false }
  activeJobs.set(opts.jobKey, job)
  const checkCancel = (): void => {
    if (job.cancelled) throw new Error('cancelled')
  }

  // Run the (CPU-heavy) separation at the lowest (idle) priority class so Windows
  // hands the CPU to interactive apps the instant they need it — the desktop,
  // Chrome, a screen recorder etc. stay fully responsive. When nothing else wants
  // the CPU the separation still runs at full speed. Only THIS (main) process
  // drops — the renderer/UI stays at normal priority. Lowering needs no admin.
  try {
    setPriority(0, osConstants.priority.PRIORITY_LOW)
  } catch {
    /* best-effort */
  }

  try {
    const modelPaths = await ensureModelPack(pack, onProgress)
    checkCancel()

    onProgress({ phase: 'decode', percent: 0, detail: 'decoding audio' })
    const [left, right] = await decodeAudio(srcPath)
    checkCancel()
    const totalLen = left.length

    const overlap = Math.floor(N_SAMPLES / 4)
    const stride = N_SAMPLES - overlap
    const nChunks = Math.max(1, Math.ceil(totalLen / stride))
    const window = transitionWindow()

    // Which model files to run and, for each, which output rows to keep.
    // single: one file, keep every row. bag: per-specialist file, keep only
    // that specialist's own row.
    const runs = pack.kind === 'single'
      ? [{ path: modelPaths[0], keep: pack.sources.map((s, i) => ({ stem: s, row: i })) }]
      : pack.files.map((f, fi) => ({
          path: modelPaths[fi],
          keep: [{ stem: f.stem!, row: pack.sources.indexOf(f.stem!) }]
        }))

    const out = new Map<string, [Float32Array, Float32Array]>()
    for (const s of pack.sources) out.set(s, [new Float32Array(totalLen), new Float32Array(totalLen)])
    const weight = new Float32Array(totalLen)
    const ort = await loadOrt()

    const totalRuns = runs.length * nChunks
    let doneRuns = 0
    let providerLabel = ''
    // GPU can fail at RUN time too (DirectML throws 8007000E out-of-memory on
    // cards without enough VRAM for the fused graph). Once it does, stop
    // trying GPU for the rest of this job and redo the chunk on CPU.
    let gpuUsable = opts.useGpu

    const mixData = new Float32Array(N_CHANNELS * N_SAMPLES)

    for (let r = 0; r < runs.length; r++) {
      checkCancel() // before loading each (bag) model — abort during setup too
      let { session, provider } = await createSession(ort, runs[r].path, gpuUsable)
      checkCancel()
      providerLabel = provider
      try {
        for (let i = 0; i < nChunks; i++) {
          checkCancel()
          const start = i * stride
          const end = Math.min(start + N_SAMPLES, totalLen)
          const chunkLen = end - start

          mixData.fill(0)
          mixData.set(left.subarray(start, end), 0)
          mixData.set(right.subarray(start, end), N_SAMPLES)

          const tensor = new ort.Tensor('float32', mixData, [1, N_CHANNELS, N_SAMPLES])
          let res: Awaited<ReturnType<typeof session.run>>
          try {
            res = await session.run({ mix: tensor })
          } catch (err) {
            if (providerLabel === 'CPU') throw err
            console.warn('GPU inference failed; falling back to CPU:', (err as Error).message)
            onProgress({ phase: 'separate', percent: Math.round((doneRuns / totalRuns) * 100), detail: 'GPU error — switching to CPU' })
            await session.release?.().catch(() => {})
            gpuUsable = false
            ;({ session, provider } = await createSession(ort, runs[r].path, false))
            providerLabel = provider
            res = await session.run({ mix: tensor })
          }
          const stems = res['stems']
          const S = stems.dims[1]

          for (const k of runs[r].keep) {
            const target = out.get(k.stem)!
            const base = k.row * N_CHANNELS * N_SAMPLES
            const l = stems.data.subarray(base, base + N_SAMPLES)
            const rr = stems.data.subarray(base + N_SAMPLES, base + 2 * N_SAMPLES)
            if (k.row >= S) throw new Error(`model emitted ${S} stems; pack expects row ${k.row}`)
            for (let n = 0; n < chunkLen; n++) {
              const w = window[n]
              target[0][start + n] += l[n] * w
              target[1][start + n] += rr[n] * w
            }
          }
          // Window weight accumulates once per chunk (identical for all runs).
          if (r === 0) {
            for (let n = 0; n < chunkLen; n++) weight[start + n] += window[n]
          }

          doneRuns++
          onProgress({
            phase: 'separate',
            percent: Math.round((doneRuns / totalRuns) * 100),
            detail: `separating on ${providerLabel}`
          })
        }
      } finally {
        await session.release?.().catch(() => {})
      }
    }

    onProgress({ phase: 'finalize', percent: 0, detail: 'writing stems' })
    for (let n = 0; n < totalLen; n++) {
      const w = Math.max(weight[n], 1e-8)
      weight[n] = 1 / w
    }
    await fsp.mkdir(outDir, { recursive: true })
    for (const s of pack.sources) {
      const [l, rr] = out.get(s)!
      for (let n = 0; n < totalLen; n++) {
        l[n] *= weight[n]
        rr[n] *= weight[n]
      }
      await writeWavFloat32(join(outDir, `${s}.wav`), [l, rr])
    }
    onProgress({ phase: 'finalize', percent: 100 })
    return finish(false)
  } finally {
    running = false
    activeJobs.delete(opts.jobKey)
    try {
      setPriority(0, osConstants.priority.PRIORITY_NORMAL)
    } catch {
      /* best-effort */
    }
  }
}

// ---- export (download buttons) ----------------------------------------------

/** Encode a cached stem WAV into the Stems download folder. format 'wav'
 *  copies; 'flac'/'mp3' re-encode via ffmpeg. Returns the written path. */
export async function exportStem(
  wavPath: string,
  format: 'wav' | 'flac' | 'mp3',
  songName: string,
  stemName: string,
  subfolder = 'Stems'
): Promise<string> {
  if (!wavPath.startsWith(stemsCacheRoot())) throw new Error('not a stems cache file')
  const safeSong = songName.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80) || 'song'
  const dir = join(stemsExportDir(subfolder), safeSong)
  await fsp.mkdir(dir, { recursive: true })
  const dest = join(dir, `${stemName}.${format}`)

  if (format === 'wav') {
    await fsp.copyFile(wavPath, dest)
    return dest
  }
  const args =
    format === 'flac'
      ? ['-y', '-v', 'error', '-i', wavPath, '-c:a', 'flac', dest]
      : ['-y', '-v', 'error', '-i', wavPath, '-c:a', 'libmp3lame', '-q:a', '2', dest]
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { windowsHide: true })
    let errTail = ''
    proc.stderr.on('data', (d: Buffer) => (errTail = (errTail + d.toString()).slice(-400)))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(errTail.trim().slice(-200)))))
  })
  return dest
}

/** Sum several stem WAVs into one instrumental WAV beside them (karaokefy's
 *  drums+bass+other → instrumental). `normalize=0` keeps original levels so the
 *  sum matches the source mix. Returns the cached path + an ampwin:// URL. */
export async function mixStems(wavPaths: string[], outName: string): Promise<{ path: string; url: string }> {
  if (!wavPaths.length) throw new Error('no stems to mix')
  for (const p of wavPaths) {
    if (!p.startsWith(stemsCacheRoot())) throw new Error('not a stems cache file')
    if (!existsSync(p)) throw new Error(`stem not found: ${p}`)
  }
  const safe = (outName || 'instrumental').replace(/[^A-Za-z0-9._-]/g, '_') || 'instrumental'
  const outPath = join(dirname(wavPaths[0]), `${safe}.wav`)
  const inputs = wavPaths.flatMap((p) => ['-i', p])
  const filter = `amix=inputs=${wavPaths.length}:duration=longest:normalize=0`
  const args = ['-y', '-v', 'error', ...inputs, '-filter_complex', filter, '-ac', '2', '-ar', String(SAMPLE_RATE), outPath]
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { windowsHide: true })
    let errTail = ''
    proc.stderr.on('data', (d: Buffer) => (errTail = (errTail + d.toString()).slice(-400)))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`mix failed: ${errTail.trim().slice(-200)}`))))
  })
  allowMediaPath(outPath)
  return { path: outPath, url: mediaUrlFor(outPath) }
}
