import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExistingRef, ImportFailure, ImportResult, RefreshResult, RelinkResult } from '../../shared/api'
import { PEAKS_PER_SECOND } from '../../shared/audio'
import { mediaKindForName, type MediaAsset } from '../../shared/project'
import { getTool } from './binaries'
import { parseProbe, runProbe } from './probe'

const MAX_IMPORT_FILES = 200

/** Tiny semaphore so we never run more than N heavy ffmpeg jobs at once. */
class Limiter {
  private active = 0
  private queue: (() => void)[] = []
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}

function execFfmpeg(bin: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal }): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 5 * 1024 * 1024, signal: opts.signal },
      (err) => (err ? reject(err) : resolve())
    )
  })
}

async function removeFileWithRetry(file: string): Promise<void> {
  const maxAttempts = 40

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await fs.rm(file, { force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code

      if (
        !['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '') ||
        attempt === maxAttempts - 1
      ) {
        throw error
      }

      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Absolute path of an asset's source file, or null if a relative path escapes the project folder. */
export function resolveAssetPath(projectDir: string, ref: ExistingRef): string | null {
  if (ref.pathKind === 'absolute') return path.isAbsolute(ref.path) ? path.normalize(ref.path) : null
  const abs = path.resolve(projectDir, ref.path)
  const rel = path.relative(projectDir, abs)
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : abs
}

function toRef(projectDir: string, file: string): ExistingRef {
  const rel = path.relative(projectDir, file)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return { path: rel.split(path.sep).join('/'), pathKind: 'relative' }
  return { path: file, pathKind: 'absolute' }
}

const sameFile = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

export class MediaService {
  private ffmpegJobs = new Limiter(2)
  private proxyJobs = new Map<string, AbortController>()

  private async tools() {
    const [ffmpeg, ffprobe] = await Promise.all([getTool('ffmpeg'), getTool('ffprobe')])
    if (!ffmpeg.path || !ffprobe.path) {
      throw new Error('FFmpeg was not found. Run "npm install" again, or install FFmpeg and restart the app')
    }
    return { ffmpeg: ffmpeg.path, ffprobe: ffprobe.path }
  }

  async toolStatus() {
    const [ffmpeg, ffprobe] = await Promise.all([getTool('ffmpeg'), getTool('ffprobe')])
    const strip = ({ found, version, source }: typeof ffmpeg) => ({ found, version, source })
    return { ffmpeg: strip(ffmpeg), ffprobe: strip(ffprobe) }
  }

  private async thumbDataUrl(projectDir: string, rel: string | null): Promise<string | null> {
    if (!rel) return null
    const abs = resolveAssetPath(projectDir, { path: rel, pathKind: 'relative' })
    if (!abs) return null
    try {
      const buf = await fs.readFile(abs)
      const mime = rel.endsWith('.png') ? 'image/png' : 'image/jpeg'
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  }

  /** Best effort: a missing thumbnail never fails an import. */
  private async makeThumbnail(
    projectDir: string,
    id: string,
    src: string,
    kind: MediaAsset['kind'],
    durationMs: number
  ): Promise<string | null> {
    const { ffmpeg } = await this.tools()
    const rel = `assets/thumbnails/${id}.${kind === 'audio' ? 'png' : 'jpg'}`
    const out = path.join(projectDir, rel)
    await fs.mkdir(path.dirname(out), { recursive: true })
    let args: string[]
    if (kind === 'audio') {
      args = ['-v', 'error', '-y', '-i', src, '-filter_complex', 'showwavespic=s=320x180:colors=0x2f7bff', '-frames:v', '1', out]
    } else if (kind === 'video') {
      const seek = Math.min(1, durationMs / 2000).toFixed(3)
      args = ['-v', 'error', '-y', '-ss', seek, '-i', src, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', out]
    } else {
      args = ['-v', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', out]
    }
    try {
      await this.ffmpegJobs.run(() => execFfmpeg(ffmpeg, args, { timeoutMs: 60_000 }))
      return (await exists(out)) ? rel : null
    } catch {
      await fs.rm(out, { force: true })
      return null
    }
  }

  private async importOne(projectDir: string, file: string): Promise<{ asset: MediaAsset; thumb: string | null }> {
    const name = path.basename(file)
    if (!path.isAbsolute(file)) throw new Error('Invalid file path')
    if (!mediaKindForName(name)) throw new Error('Unsupported file type')
    const stat = await fs.stat(file).catch(() => null)
    if (!stat?.isFile()) throw new Error('File not found')

    const { ffprobe } = await this.tools()
    const info = parseProbe(await runProbe(ffprobe, file), name)
    const id = randomUUID()
    const ref = toRef(projectDir, file)
    const thumbnail = await this.makeThumbnail(projectDir, id, file, info.kind, info.durationMs)
    const asset: MediaAsset = {
      id,
      name,
      ...ref,
      sizeBytes: stat.size,
      ...info,
      thumbnail,
      proxy: null,
      importedAt: new Date().toISOString()
    }
    return { asset, thumb: await this.thumbDataUrl(projectDir, thumbnail) }
  }

  async importFiles(projectDir: string, files: string[], existing: ExistingRef[]): Promise<ImportResult> {
    const result: ImportResult = { assets: [], thumbs: {}, failures: [] }
    const known = existing
      .map((e) => resolveAssetPath(projectDir, e))
      .filter((p): p is string => p !== null)
    const unique = [...new Set(files)].slice(0, MAX_IMPORT_FILES)
    const failures: ImportFailure[] = result.failures
    if (files.length > MAX_IMPORT_FILES) failures.push({ name: '(extra files)', error: `Only ${MAX_IMPORT_FILES} files can be imported at once` })

    await Promise.all(
      unique.map(async (file) => {
        const name = path.basename(file)
        if (known.some((k) => sameFile(k, path.normalize(file)))) {
          failures.push({ name, error: 'Already in this project' })
          return
        }
        try {
          const { asset, thumb } = await this.importOne(projectDir, path.normalize(file))
          result.assets.push(asset)
          if (thumb) result.thumbs[asset.id] = thumb
        } catch (e) {
          failures.push({ name, error: e instanceof Error ? e.message : 'Import failed' })
        }
      })
    )
    // Promise.all finishes in arbitrary order; keep the user's selection order.
    result.assets.sort((a, b) => unique.findIndex((f) => path.basename(f) === a.name) - unique.findIndex((f) => path.basename(f) === b.name))
    return result
  }

  async refresh(projectDir: string, assets: MediaAsset[], haveThumbs: string[]): Promise<RefreshResult> {
    const have = new Set(haveThumbs)
    const missing: string[] = []
    const thumbs: Record<string, string> = {}
    await Promise.all(
      assets.map(async (a) => {
        const abs = resolveAssetPath(projectDir, a)
        if (!abs || !(await exists(abs))) missing.push(a.id)
        if (a.thumbnail && !have.has(a.id)) {
          const url = await this.thumbDataUrl(projectDir, a.thumbnail)
          if (url) thumbs[a.id] = url
        }
      })
    )
    return { missing, thumbs }
  }

  async relink(projectDir: string, old: MediaAsset, newFile: string): Promise<RelinkResult> {
    const { asset, thumb } = await this.importOne(projectDir, path.normalize(newFile))
    if (asset.kind !== old.kind) throw new Error(`That file is ${asset.kind}, but this item is ${old.kind}`)
    // Keep identity (so future clips keep pointing at it), take the new file's location and metadata.
    const merged: MediaAsset = { ...asset, id: old.id, importedAt: old.importedAt, proxy: old.proxy }
    if (asset.thumbnail) {
      // importOne wrote the thumbnail under the throwaway id; move it under the original id.
      const from = path.join(projectDir, asset.thumbnail)
      const rel = `assets/thumbnails/${old.id}${path.extname(asset.thumbnail)}`
      await fs.rename(from, path.join(projectDir, rel)).catch(() => undefined)
      merged.thumbnail = rel
    } else {
      merged.thumbnail = old.thumbnail
    }
    const durationDiffers = old.kind !== 'image' && Math.abs(asset.durationMs - old.durationMs) > 1000
    return { asset: merged, thumb, durationDiffers }
  }

  async makeProxy(projectDir: string, asset: MediaAsset): Promise<string> {
    if (asset.kind !== 'video') throw new Error('Proxies can only be made for video')
    if (this.proxyJobs.has(asset.id)) throw new Error('A proxy is already being made for this item')
    const src = resolveAssetPath(projectDir, asset)
    if (!src || !(await exists(src))) throw new Error('The source file is missing')
    const { ffmpeg } = await this.tools()

    const rel = `assets/proxies/${asset.id}.mp4`
    const out = path.join(projectDir, rel)
    const tmp = path.join(projectDir, `assets/proxies/${asset.id}.tmp.mp4`)
    await fs.mkdir(path.dirname(out), { recursive: true })

    const ctl = new AbortController()
    this.proxyJobs.set(asset.id, ctl)
    try {
      await this.ffmpegJobs.run(() =>
        execFfmpeg(
          ffmpeg,
          ['-v', 'error', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=-2:540', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', tmp],
          { timeoutMs: 2 * 60 * 60_000, signal: ctl.signal }
        )
      )
      await fs.rename(tmp, out)
      return rel
    } catch (e) {
      await removeFileWithRetry(tmp)

      if (ctl.signal.aborted) {
        throw new Error('Proxy cancelled')
      }

      void e
      throw new Error('Proxy generation failed')
    } finally {
      this.proxyJobs.delete(asset.id)
    }
  }

  /**
   * Loudness peaks for drawing waveforms: one byte (0-255) per 20 ms. Cached under
   * assets/waveforms, keyed by the file size so a relinked file gets fresh peaks.
   */
  async waveform(projectDir: string, asset: MediaAsset): Promise<Uint8Array | null> {
    if (asset.kind !== 'audio') return null
    const src = resolveAssetPath(projectDir, asset)
    if (!src || !(await exists(src))) return null
    const cacheRel = `assets/waveforms/${asset.id}-${asset.sizeBytes}.peaks`
    const cache = path.join(projectDir, cacheRel)
    try {
      return new Uint8Array(await fs.readFile(cache))
    } catch {
      /* not cached yet */
    }
    const { ffmpeg } = await this.tools()
    const peaks = await this.ffmpegJobs.run(() => computePeaks(ffmpeg, src))
    if (!peaks) return null
    await fs.mkdir(path.dirname(cache), { recursive: true })
    await fs.writeFile(cache, peaks)
    return peaks
  }

  cancelProxy(id: string): void {
    this.proxyJobs.get(id)?.abort()
  }
}

/** Decode to 8 kHz mono and keep the loudest sample in each 20 ms window (square-rooted so quiet audio is visible). */
function computePeaks(ffmpeg: string, src: string): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const perBucket = 8000 / PEAKS_PER_SECOND
    const out: number[] = []
    let max = 0
    let count = 0
    let carry: Buffer = Buffer.alloc(0)
    const child = spawn(ffmpeg, ['-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { windowsHide: true })
    const timer = setTimeout(() => child.kill(), 3 * 60_000)
    child.stdout.on('data', (chunk: Buffer) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const usable = buf.length - (buf.length % 2)
      for (let i = 0; i < usable; i += 2) {
        const v = Math.abs(buf.readInt16LE(i))
        if (v > max) max = v
        if (++count === perBucket) {
          out.push(Math.min(255, Math.round(Math.sqrt(max / 32768) * 255)))
          max = 0
          count = 0
        }
      }
      carry = buf.subarray(usable)
    })
    child.stderr.on('data', () => undefined)
    child.on('error', () => (clearTimeout(timer), resolve(null)))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (count > 0) out.push(Math.min(255, Math.round(Math.sqrt(max / 32768) * 255)))
      resolve(code === 0 && out.length > 0 ? Uint8Array.from(out) : null)
    })
  })
}
