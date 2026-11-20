import { z } from 'zod'
import type { Clip, MediaAsset, Project, ProjectSettings, Track } from './project'
import { clipEnd, timelineEnd } from './timeline'
import { effectsOf, isMoved, isZoomed } from './effects'

/** Pure export planning: settings, output size, and the FFmpeg filter graph. No I/O here. */

export const RESOLUTIONS = ['project', '720p', '1080p', '1440p', '2160p'] as const
export const QUALITIES = ['draft', 'standard', 'high'] as const
export const ENCODERS = ['auto', 'cpu', 'nvenc'] as const

export const ExportSettingsSchema = z.object({
  resolution: z.enum(RESOLUTIONS),
  quality: z.enum(QUALITIES),
  encoder: z.enum(ENCODERS),
  outputDir: z.enum(['project', 'custom']),
  fileName: z.string().trim().min(1).max(100)
})
export type ExportSettings = z.infer<typeof ExportSettingsSchema>

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  resolution: '1080p',
  quality: 'standard',
  encoder: 'auto',
  outputDir: 'project',
  fileName: 'export'
}

export const QUALITY_PRESETS = {
  draft: { label: 'Draft (fast, smaller)', crf: 28, x264Preset: 'veryfast', nvencCq: 32 },
  standard: { label: 'Standard', crf: 23, x264Preset: 'medium', nvencCq: 26 },
  high: { label: 'High (slow, larger)', crf: 18, x264Preset: 'slow', nvencCq: 21 }
} as const

const SHORT_SIDE: Record<string, number> = { '720p': 720, '1080p': 1080, '1440p': 1440, '2160p': 2160 }
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/** Output pixel size. Presets name the shorter side, so portrait projects keep their shape. H.264 needs even sizes. */
export function outputSize(project: ProjectSettings, resolution: ExportSettings['resolution']): { width: number; height: number } {
  if (resolution === 'project') return { width: even(project.width), height: even(project.height) }
  const short = SHORT_SIDE[resolution]
  const k = short / Math.min(project.width, project.height)
  return { width: even(project.width * k), height: even(project.height * k) }
}

export const SAMPLE_RATE = 48000

export interface RenderPlanOptions {
  width: number
  height: number
  resolvePath(asset: MediaAsset): string
  /** Per subtitle track id: path of the concat list that plays that track's subtitle images over time. */
  subtitleLists: Record<string, string>
}

export interface RenderPlan {
  /** Input arguments (everything before -filter_complex), in input order. */
  inputs: string[]
  filter: string
  totalFrames: number
  seconds: number
  fps: number
}

interface Entry {
  clip: Clip
  asset: MediaAsset
  track: Track
  trackIndex: number
}

const fmt = (n: number) => n.toFixed(6)

/** The clips that draw something: video/image clips on visible video and overlay tracks. */
export function visualEntries(p: Pick<Project, 'clips' | 'tracks' | 'media'>): Entry[] {
  return entriesOf(p).filter((e) => e.asset.kind !== 'audio' && (e.track.kind === 'video' || e.track.kind === 'overlay') && e.track.visible)
}

/** The clips that make sound; matches the preview (overlay tracks and muted tracks are silent). */
export function audibleEntries(p: Pick<Project, 'clips' | 'tracks' | 'media'>): Entry[] {
  return entriesOf(p).filter(
    (e) =>
      e.asset.kind !== 'image' &&
      !!e.asset.audioCodec &&
      (e.track.kind === 'video' || e.track.kind === 'audio') &&
      !e.track.muted &&
      e.clip.volume > 0 &&
      e.track.volume > 0
  )
}

function entriesOf(p: Pick<Project, 'clips' | 'tracks' | 'media'>): Entry[] {
  const tracks = new Map(p.tracks.map((t, i) => [t.id, { t, i }]))
  const assets = new Map(p.media.map((a) => [a.id, a]))
  const out: Entry[] = []
  for (const clip of p.clips) {
    const t = tracks.get(clip.trackId)
    const asset = assets.get(clip.assetId)
    if (t && asset && t.t.kind !== 'subtitle') out.push({ clip, asset, track: t.t, trackIndex: t.i })
  }
  return out
}

export function buildRenderPlan(project: Project, opts: RenderPlanOptions): RenderPlan {
  const fps = project.settings.fps
  const totalFrames = timelineEnd(project)
  if (totalFrames <= 0) throw new Error('The timeline is empty. Add clips or subtitles before exporting')
  const sec = (frames: number) => fmt(frames / fps)
  const total = sec(totalFrames)
  const { width: W, height: H } = opts

  const visual = visualEntries(project).sort((a, b) => b.trackIndex - a.trackIndex || a.clip.startFrame - b.clip.startFrame) // bottom layer first
  const audible = audibleEntries(project).sort((a, b) => a.clip.startFrame - b.clip.startFrame)

  // One FFmpeg input per clip, opened at the clip's source in-point and cut to its length.
  const needs = new Map<string, { v: boolean; a: boolean; entry: Entry }>()
  for (const e of visual) needs.set(e.clip.id, { v: true, a: false, entry: e })
  for (const e of audible) needs.set(e.clip.id, { v: needs.get(e.clip.id)?.v ?? false, a: true, entry: e })
  const order = [...needs.values()].sort((x, y) => x.entry.clip.startFrame - y.entry.clip.startFrame || x.entry.trackIndex - y.entry.trackIndex)

  const inputs: string[] = []
  const index = new Map<string, number>()
  let nextInput = 0
  for (const { v, a, entry } of order) {
    const { clip, asset } = entry
    const path = opts.resolvePath(asset)
    if (asset.kind === 'image') {
      inputs.push('-loop', '1', '-framerate', String(fps), '-t', sec(clip.durationFrames), '-i', path)
    } else {
      inputs.push(...(v ? [] : ['-vn']), ...(a ? [] : ['-an']), '-ss', sec(clip.sourceInFrame), '-t', sec(clip.durationFrames), '-i', path)
    }
    index.set(clip.id, nextInput++)
  }

  const parts: string[] = []
  const halfFrame = 0.5 / fps

  // Picture: black canvas, then every visual clip stacked bottom to top, then subtitles.
  parts.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${total},format=rgba[b0]`)
  let layer = 0
  for (const { clip, asset } of visual) {
    const i = index.get(clip.id) as number
    const start = clip.startFrame / fps
    const end = clipEnd(clip) / fps
    const fx = effectsOf(clip)
    const lastFrame = Math.max(1, clip.durationFrames - 1)
    // Zoom: scale up 2x first so the integer-pixel crop that zoompan does looks smooth, then zoom about the centre.
    const zoom = isZoomed(fx)
      ? `,scale=${W * 2}:${H * 2}:flags=bicubic,zoompan=z='${(fx.scaleStart / 100).toFixed(4)}+${((fx.scaleEnd - fx.scaleStart) / 100).toFixed(4)}*on/${lastFrame}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps},format=rgba`
      : ''
    const opacity = fx.opacity < 100 ? `,colorchannelmixer=aa=${(fx.opacity / 100).toFixed(4)}` : ''
    parts.push(
      `[${i}:v]${asset.kind === 'video' ? `fps=${fps},` : ''}format=rgba,` +
        `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,` +
        // Effects and picture fades are measured from the clip's own start, so they come before the shift to timeline time.
        `setpts=PTS-STARTPTS` +
        zoom +
        opacity +
        (clip.videoFadeInFrames > 0 ? `,fade=t=in:st=0:d=${sec(clip.videoFadeInFrames)}:alpha=1` : '') +
        (clip.videoFadeOutFrames > 0 ? `,fade=t=out:st=${sec(clip.durationFrames - clip.videoFadeOutFrames)}:d=${sec(clip.videoFadeOutFrames)}:alpha=1` : '') +
        `,setpts=PTS+${fmt(start)}/TB[v${i}]`
    )
    // Position: the overlay is offset by a share of the frame size, animated across the clip when the start and end differ.
    let place = ''
    if (isMoved(fx)) {
      const span = fmt(lastFrame / fps)
      const p = `clip((t-${fmt(start)})/${span},0,1)`
      const pos = (a: number, b: number, size: 'main_w' | 'main_h') => (a === b ? `${a}*${size}/100` : `(${a}+(${b - a})*${p})*${size}/100`)
      place = `x='(main_w-overlay_w)/2+${pos(fx.posStartX, fx.posEndX, 'main_w')}':y='(main_h-overlay_h)/2+${pos(fx.posStartY, fx.posEndY, 'main_h')}':`
    }
    parts.push(`[b${layer}][v${i}]overlay=${place}format=auto:eof_action=pass:enable='gte(t,${fmt(Math.max(0, start - halfFrame))})*lt(t,${fmt(end - halfFrame)})'[b${layer + 1}]`)
    layer++
  }
  const subtitleTracks = project.tracks.filter((t) => t.kind === 'subtitle' && t.visible && opts.subtitleLists[t.id]).reverse() // lower rows first, so the first row ends up on top
  for (const t of subtitleTracks) {
    const i = nextInput++
    inputs.push('-f', 'concat', '-safe', '0', '-i', opts.subtitleLists[t.id])
    parts.push(`[${i}:v]format=rgba[s${i}]`)
    parts.push(`[b${layer}][s${i}]overlay=format=auto:eof_action=pass[b${layer + 1}]`)
    layer++
  }
  parts.push(`[b${layer}]format=yuv420p[vout]`)

  // Sound: each clip is levelled, faded, delayed to its place and padded to full length so all
  // inputs last the same time. That keeps amix's 1/N scaling constant, which volume=N undoes.
  const padSamples = Math.round(totalFrames / fps * SAMPLE_RATE)
  const labels: string[] = []
  for (const { clip, track, asset } of audible) {
    const i = index.get(clip.id) as number
    const gain = (clip.volume / 100) * (track.volume / 100)
    // A mono file plays at full level on both sides in the preview; FFmpeg's default upmix would
    // lower it by 3 dB, so copy the channel explicitly.
    const toStereo =
      asset.channels === 1
        ? `pan=stereo|c0=c0|c1=c0,aformat=sample_fmts=fltp`
        : `aformat=sample_fmts=fltp:channel_layouts=stereo`
    let c = `[${i}:a]aresample=${SAMPLE_RATE},${toStereo}`
    if (gain !== 1) c += `,volume=${gain.toFixed(4)}`
    if (clip.fadeInFrames > 0) c += `,afade=t=in:st=0:d=${sec(clip.fadeInFrames)}`
    if (clip.fadeOutFrames > 0) c += `,afade=t=out:st=${sec(clip.durationFrames - clip.fadeOutFrames)}:d=${sec(clip.fadeOutFrames)}`
    const delayMs = Math.round((clip.startFrame / fps) * 1000)
    if (delayMs > 0) c += `,adelay=${delayMs}|${delayMs}`
    c += `,apad=pad_len=${padSamples}[a${i}]`
    parts.push(c)
    labels.push(`[a${i}]`)
  }
  if (labels.length === 0) parts.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=end=${total}[aout]`)
  else if (labels.length === 1) parts.push(`${labels[0]}atrim=end=${total}[aout]`)
  else parts.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0,volume=${labels.length},atrim=end=${total}[aout]`)

  return { inputs, filter: parts.join(';'), totalFrames, seconds: totalFrames / fps, fps }
}

/** Text for FFmpeg's concat demuxer: plays each subtitle image for its cue and a transparent frame in the gaps. */
export function buildSubtitleConcat(
  cues: readonly { startFrame: number; durationFrames: number; imagePath: string }[],
  fps: number,
  totalFrames: number,
  blankPath: string
): string {
  const q = (p: string) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
  const lines = ['ffconcat version 1.0']
  let pos = 0
  let last = blankPath
  const add = (file: string, frames: number) => {
    if (frames <= 0) return
    lines.push(q(file), `duration ${fmt(frames / fps)}`)
    last = file
  }
  for (const c of [...cues].sort((a, b) => a.startFrame - b.startFrame)) {
    add(blankPath, c.startFrame - pos)
    add(c.imagePath, c.durationFrames)
    pos = c.startFrame + c.durationFrames
  }
  add(blankPath, totalFrames - pos)
  if (lines.length === 1) add(blankPath, totalFrames)
  lines.push(q(last)) // the demuxer ignores the final duration unless the last file is repeated
  return lines.join('\n') + '\n'
}

export interface EncodeSettings {
  encoder: 'cpu' | 'nvenc'
  quality: ExportSettings['quality']
}

export function encodeArgs({ encoder, quality }: EncodeSettings): string[] {
  const q = QUALITY_PRESETS[quality]
  const video =
    encoder === 'nvenc'
      ? ['-c:v', 'h264_nvenc', '-preset', 'slow', '-rc', 'vbr', '-cq', String(q.nvencCq), '-b:v', '0', '-profile:v', 'high']
      : ['-c:v', 'libx264', '-preset', q.x264Preset, '-crf', String(q.crf), '-profile:v', 'high']
  return [...video, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', String(SAMPLE_RATE), '-ac', '2', '-movflags', '+faststart']
}
