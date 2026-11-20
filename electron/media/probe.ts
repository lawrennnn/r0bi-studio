import { execFile } from 'node:child_process'
import { mediaKindForName, type MediaKind } from '../../shared/project'

export interface ProbeInfo {
  kind: MediaKind
  durationMs: number
  width: number
  height: number
  fpsNum: number
  fpsDen: number
  videoCodec: string | null
  audioCodec: string | null
  sampleRate: number
  channels: number
}

interface RawStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  sample_rate?: string
  channels?: number
  duration?: string
  disposition?: { attached_pic?: number }
  tags?: { rotate?: string }
  side_data_list?: { rotation?: number }[]
}
interface RawProbe {
  streams?: RawStream[]
  format?: { duration?: string }
}

function parseFraction(s: string | undefined): [number, number] | null {
  const m = /^(\d+)\/(\d+)$/.exec(s ?? '')
  if (!m) return null
  const n = Number(m[1])
  const d = Number(m[2])
  return n > 0 && d > 0 ? [n, d] : null
}

function rotationOf(s: RawStream): number {
  const raw = s.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? Number(s.tags?.rotate ?? 0)
  return Math.abs(Math.round(Number(raw) || 0)) % 180
}

/** Turn ffprobe's JSON into the fields we store. Pure, so it is easy to test. */
export function parseProbe(raw: RawProbe, fileName: string): ProbeInfo {
  const ext = mediaKindForName(fileName)
  if (!ext) throw new Error('Unsupported file type')
  const streams = raw.streams ?? []
  // Cover art in an MP3 shows up as a "video" stream; it is not real video.
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = streams.find((s) => s.codec_type === 'audio')

  let kind: MediaKind = ext
  if (kind === 'video' && !video) {
    if (!audio) throw new Error('No video or audio stream found')
    kind = 'audio'
  }
  if (kind === 'image' && !video) throw new Error('Not a readable image')
  if (kind === 'audio' && !audio) throw new Error('No audio stream found')

  let width = 0
  let height = 0
  let fpsNum = 0
  let fpsDen = 0
  if ((kind === 'video' || kind === 'image') && video) {
    width = video.width ?? 0
    height = video.height ?? 0
    if (rotationOf(video) === 90) [width, height] = [height, width]
    if (kind === 'video') {
      const fps = parseFraction(video.avg_frame_rate) ?? parseFraction(video.r_frame_rate)
      if (fps) [fpsNum, fpsDen] = fps
    }
  }

  let durationMs = 0
  if (kind !== 'image') {
    const seconds = Number(raw.format?.duration ?? video?.duration ?? audio?.duration ?? 0)
    durationMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0
  }

  return {
    kind,
    durationMs,
    width,
    height,
    fpsNum,
    fpsDen,
    videoCodec: kind === 'audio' ? null : (video?.codec_name ?? null),
    audioCodec: audio?.codec_name ?? null,
    sampleRate: Number(audio?.sample_rate ?? 0) || 0,
    channels: audio?.channels ?? 0
  }
}

export function runProbe(ffprobe: string, file: string): Promise<RawProbe> {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', file],
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(new Error('Could not read this file. It may be damaged or unsupported'))
        try {
          resolve(JSON.parse(String(stdout)) as RawProbe)
        } catch {
          reject(new Error('Could not read this file'))
        }
      }
    )
  })
}
