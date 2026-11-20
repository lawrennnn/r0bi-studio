import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Project } from '../../shared/project'
import { audibleEntries, buildRenderPlan, buildSubtitleConcat, encodeArgs, outputSize, visualEntries, type ExportSettings } from '../../shared/render'
import { parseProbe, runProbe } from '../media/probe'
import { resolveAssetPath } from '../media/mediaService'

export class RenderCancelled extends Error {
  constructor() {
    super('Export cancelled')
  }
}

export interface Verification {
  ok: boolean
  width: number
  height: number
  fps: number
  durationSec: number
  videoCodec: string | null
  audioCodec: string | null
  problems: string[]
}

export interface RenderOptions {
  ffmpeg: string
  ffprobe: string
  project: Project
  projectDir: string
  settings: ExportSettings
  encoder: 'cpu' | 'nvenc'
  /** Final file; the render goes to "<outFile>.partial" first and is renamed only after verification. */
  outFile: string
  /** Scratch folder for filter scripts and subtitle lists. */
  tempDir: string
  /** Subtitle cue id -> PNG path (full-frame, at the output size). */
  subtitleImages: Record<string, string>
  /** A fully transparent PNG at the output size, used between subtitles. */
  blankImage: string | null
  onProgress(fraction: number): void
  signal?: AbortSignal
  /** Filters longer than this go through a script file (Windows limits the command line to about 32k). */
  filterLimit?: number
}

const tail = (s: string, n = 1500) => (s.length > n ? s.slice(-n) : s)
const exists = (p: string) => fs.access(p).then(() => true, () => false)

const nvencCache = new Map<string, Promise<boolean>>()

/** True only if this FFmpeg has h264_nvenc AND a real test encode works (so a missing GPU/driver is caught). */
export function detectNvenc(ffmpeg: string): Promise<boolean> {
  let p = nvencCache.get(ffmpeg)
  if (!p) {
    p = new Promise<boolean>((resolve) => {
      execFile(ffmpeg, ['-hide_banner', '-encoders'], { timeout: 10_000, windowsHide: true }, (err, out) => {
        if (err || !String(out).includes('h264_nvenc')) return resolve(false)
        execFile(
          ffmpeg,
          ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-'],
          { timeout: 20_000, windowsHide: true },
          (e) => resolve(!e)
        )
      })
    })
    nvencCache.set(ffmpeg, p)
  }
  return p
}

export function resolveEncoder(requested: ExportSettings['encoder'], nvencAvailable: boolean): 'cpu' | 'nvenc' {
  if (requested === 'cpu') return 'cpu'
  if (requested === 'nvenc') return nvencAvailable ? 'nvenc' : 'cpu'
  return nvencAvailable ? 'nvenc' : 'cpu'
}

/** Check the finished file with FFprobe against what we asked for. */
export async function verifyOutput(ffprobe: string, file: string, expect: { width: number; height: number; fps: number; seconds: number }): Promise<Verification> {
  const info = parseProbe(await runProbe(ffprobe, file), 'output.mp4')
  const fps = info.fpsDen ? info.fpsNum / info.fpsDen : 0
  const problems: string[] = []
  if (info.width !== expect.width || info.height !== expect.height) problems.push(`size is ${info.width}x${info.height}, expected ${expect.width}x${expect.height}`)
  if (info.videoCodec !== 'h264') problems.push(`video codec is ${info.videoCodec ?? 'missing'}, expected h264`)
  if (info.audioCodec !== 'aac') problems.push(`audio codec is ${info.audioCodec ?? 'missing'}, expected aac`)
  if (Math.abs(fps - expect.fps) > 0.05) problems.push(`frame rate is ${fps.toFixed(2)}, expected ${expect.fps}`)
  const seconds = info.durationMs / 1000
  if (Math.abs(seconds - expect.seconds) > Math.max(0.3, 3 / expect.fps)) problems.push(`length is ${seconds.toFixed(2)} s, expected ${expect.seconds.toFixed(2)} s`)
  return { ok: problems.length === 0, width: info.width, height: info.height, fps, durationSec: seconds, videoCodec: info.videoCodec, audioCodec: info.audioCodec, problems }
}

function runFfmpeg(ffmpeg: string, args: string[], totalSeconds: number, onProgress: (f: number) => void, signal?: AbortSignal): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true })
    let stderr = ''
    let buffer = ''
    let lastReported = -1
    const report = (seconds: number) => {
      const f = Math.min(1, Math.max(0, seconds / totalSeconds))
      if (f - lastReported >= 0.002 || f === 1) {
        lastReported = f
        onProgress(f)
      }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const us = /^out_time_(?:us|ms)=(\d+)/.exec(line)
        if (us) return void report(Number(us[1]) / 1e6)
        const t = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line)
        if (t) report(Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]))
      }
    })
    child.stderr.on('data', (c: Buffer) => (stderr = tail(stderr + c.toString(), 6000)))
    const onAbort = () => child.kill()
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.on('error', (e) => reject(e))
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      resolve({ code, stderr })
    })
  })
}

/** Render the project to an MP4. Throws RenderCancelled, or an Error with a readable reason. */
export async function runRender(o: RenderOptions): Promise<{ outFile: string; verification: Verification; seconds: number }> {
  const { project } = o
  const { width, height } = outputSize(project.settings, o.settings.resolution)

  // 1. Every file we need must exist, and we say which ones do not.
  const used = [...visualEntries(project), ...audibleEntries(project)]
  const sources = new Map<string, string>()
  const missing = new Set<string>()
  for (const { asset } of used) {
    const p = resolveAssetPath(o.projectDir, asset)
    if (p && (await exists(p))) sources.set(asset.id, p)
    else missing.add(asset.name)
  }
  if (missing.size > 0) throw new Error(`These media files are missing: ${[...missing].slice(0, 5).join(', ')}${missing.size > 5 ? ` and ${missing.size - 5} more` : ''}. Locate them in the library first`)

  // 2. Subtitle image lists (one per visible subtitle track).
  await fs.mkdir(o.tempDir, { recursive: true })
  const subtitleLists: Record<string, string> = {}
  const totalFramesGuess = Math.max(0, ...project.clips.map((c) => c.startFrame + c.durationFrames), ...project.subtitles.map((c) => c.startFrame + c.durationFrames))
  for (const t of project.tracks.filter((x) => x.kind === 'subtitle' && x.visible)) {
    const cues = project.subtitles
      .filter((c) => c.trackId === t.id && o.subtitleImages[c.id])
      .map((c) => ({ startFrame: c.startFrame, durationFrames: c.durationFrames, imagePath: o.subtitleImages[c.id] }))
    if (cues.length === 0) continue
    if (!o.blankImage) throw new Error('Subtitle images were not prepared')
    const list = path.join(o.tempDir, `subtitles-${t.id}.txt`)
    await fs.writeFile(list, buildSubtitleConcat(cues, project.settings.fps, totalFramesGuess, o.blankImage), 'utf8')
    subtitleLists[t.id] = list
  }

  // 3. The filter graph.
  const plan = buildRenderPlan(project, { width, height, resolvePath: (a) => sources.get(a.id) as string, subtitleLists })

  const partial = `${o.outFile}.partial`
  const base = (filterArgs: string[]) => [
    '-hide_banner', '-v', 'error', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats',
    ...plan.inputs, ...filterArgs,
    '-map', '[vout]', '-map', '[aout]',
    ...encodeArgs({ encoder: o.encoder, quality: o.settings.quality }),
    '-t', plan.seconds.toFixed(6), '-f', 'mp4', partial
  ]

  const limit = o.filterLimit ?? 24_000
  const useScript = plan.filter.length > limit
  let scriptFile = ''
  let filterArgs = ['-filter_complex', plan.filter]
  if (useScript) {
    scriptFile = path.join(o.tempDir, 'filter.txt')
    await fs.writeFile(scriptFile, plan.filter, 'utf8')
    filterArgs = ['-filter_complex_script', scriptFile]
  }
  let args = base(filterArgs)
  if (process.platform === 'win32' && args.reduce((n, a) => n + a.length + 1, 0) > 31_000) {
    throw new Error('This project has too many clips to export in one pass. Export it in parts')
  }

  // 4. Run FFmpeg. Newer versions renamed the script option; retry once with the new spelling.
  o.signal?.throwIfAborted?.()
  let result = await runFfmpeg(o.ffmpeg, args, plan.seconds, o.onProgress, o.signal)
  if (result.code !== 0 && useScript && !o.signal?.aborted && /Unrecognized option|Option not found/i.test(result.stderr)) {
    args = base(['-/filter_complex', scriptFile])
    result = await runFfmpeg(o.ffmpeg, args, plan.seconds, o.onProgress, o.signal)
  }
  if (o.signal?.aborted) {
    await fs.rm(partial, { force: true })
    throw new RenderCancelled()
  }
  if (result.code !== 0) {
    await fs.rm(partial, { force: true })
    const reason = result.stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ')
    throw new Error(`FFmpeg could not render the video${reason ? `: ${reason}` : ''}`)
  }

  // 5. Verify what was written before it gets its real name.
  const verification = await verifyOutput(o.ffprobe, partial, { width, height, fps: project.settings.fps, seconds: plan.seconds })
  if (!verification.ok) {
    await fs.rm(partial, { force: true })
    throw new Error(`The exported file did not pass verification: ${verification.problems.join('; ')}`)
  }
  await fs.rename(partial, o.outFile)
  o.onProgress(1)
  return { outFile: o.outFile, verification, seconds: plan.seconds }
}
