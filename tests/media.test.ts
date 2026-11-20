import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getTool } from '../electron/media/binaries'
import { parseProbe } from '../electron/media/probe'
import { MediaService, resolveAssetPath } from '../electron/media/mediaService'
import { ProjectManager } from '../electron/projectManager'
import { createEmptyProject, migrateProject, ProjectSchema } from '../shared/project'

let root: string
let projectDir: string
let ffmpegPath = ''
let ffprobePath = ''
const svc = new MediaService()
const files: Record<string, string> = {}

const ff = (args: string[]) => execFileSync(ffmpegPath, ['-v', 'error', '-y', ...args])

beforeAll(async () => {
  const [a, b] = await Promise.all([getTool('ffmpeg'), getTool('ffprobe')])
  expect(a.path && b.path, 'FFmpeg/FFprobe must be available').toBeTruthy()
  ffmpegPath = a.path!
  ffprobePath = b.path!
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'r0bi-media-'))
  const m = new ProjectManager()
  projectDir = (await m.create(root, 'Media Test')).dir
  const ext = path.join(root, 'external')
  await fs.mkdir(ext)
  files.video = path.join(ext, 'clip.mp4')
  files.khmerVideo = path.join(ext, 'វីដេអូ test.mp4')
  files.image = path.join(ext, 'pic.png')
  files.audio = path.join(ext, 'voice.wav')
  files.mp3 = path.join(ext, 'music.mp3')
  files.inside = path.join(projectDir, 'assets/video/inside.mp4')
  ff(['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', files.video])
  await fs.copyFile(files.video, files.khmerVideo)
  await fs.copyFile(files.video, files.inside)
  ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360', '-frames:v', '1', files.image])
  ff(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100', '-t', '1.5', files.audio])
  ff(['-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '1', '-c:a', 'libmp3lame', files.mp3])
}, 60_000)

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('parseProbe (pure)', () => {
  it('swaps width/height for 90 degree rotated phone video', () => {
    const info = parseProbe(
      { format: { duration: '3.5' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001', side_data_list: [{ rotation: -90 }] }] },
      'a.mov'
    )
    expect([info.width, info.height, info.fpsNum, info.fpsDen, info.durationMs]).toEqual([1080, 1920, 30000, 1001, 3500])
  })
  it('treats MP3 cover art as audio, not video', () => {
    const info = parseProbe(
      { format: { duration: '10' }, streams: [{ codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 2 }, { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } }] },
      'a.mp3'
    )
    expect(info.kind).toBe('audio')
    expect(info.videoCodec).toBeNull()
  })
  it('rejects unsupported and empty files', () => {
    expect(() => parseProbe({ streams: [] }, 'a.txt')).toThrow(/Unsupported/)
    expect(() => parseProbe({ streams: [] }, 'a.mp4')).toThrow()
  })
})

describe('MediaService with real FFmpeg', () => {
  it('imports video, image, audio and mp3 with correct metadata and thumbnails', async () => {
    const res = await svc.importFiles(projectDir, [files.video, files.image, files.audio, files.mp3], [])
    expect(res.failures).toEqual([])
    const by = Object.fromEntries(res.assets.map((a) => [a.name, a]))
    const v = by['clip.mp4']
    expect([v.kind, v.width, v.height, v.fpsNum / v.fpsDen, v.videoCodec, v.audioCodec]).toEqual(['video', 1280, 720, 30, 'h264', 'aac'])
    expect(v.durationMs).toBeGreaterThan(1900)
    expect(v.durationMs).toBeLessThan(2200)
    expect(v.pathKind).toBe('absolute')
    expect(v.sizeBytes).toBeGreaterThan(0)
    const i = by['pic.png']
    expect([i.kind, i.width, i.height, i.durationMs]).toEqual(['image', 640, 360, 0])
    const w = by['voice.wav']
    expect([w.kind, w.sampleRate, w.videoCodec]).toEqual(['audio', 44100, null])
    expect(by['music.mp3'].kind).toBe('audio')
    for (const a of res.assets) {
      expect(a.thumbnail, a.name).toBeTruthy()
      expect(res.thumbs[a.id]).toMatch(/^data:image\/(jpeg|png);base64,/)
      expect((await fs.stat(path.join(projectDir, a.thumbnail!))).size).toBeGreaterThan(100)
    }
    // the project schema accepts what the service produces
    const p = { ...createEmptyProject('x'), media: res.assets }
    expect(ProjectSchema.safeParse(p).success).toBe(true)
  }, 60_000)

  it('handles non-Latin (Khmer) file names', async () => {
    const res = await svc.importFiles(projectDir, [files.khmerVideo], [])
    expect(res.failures).toEqual([])
    expect(res.assets[0].name).toBe('វីដេអូ test.mp4')
    expect(res.assets[0].thumbnail).toBeTruthy()
  }, 30_000)

  it('stores files inside the project folder as relative paths', async () => {
    const res = await svc.importFiles(projectDir, [files.inside], [])
    const a = res.assets[0]
    expect([a.pathKind, a.path]).toEqual(['relative', 'assets/video/inside.mp4'])
    expect(resolveAssetPath(projectDir, a)).toBe(files.inside)
  }, 30_000)

  it('reports failures without aborting the rest, and skips duplicates', async () => {
    const bad = path.join(root, 'external', 'broken.mp4')
    await fs.writeFile(bad, 'not a video')
    const txt = path.join(root, 'external', 'notes.txt')
    await fs.writeFile(txt, 'hi')
    const res = await svc.importFiles(projectDir, [bad, txt, path.join(root, 'nope.mp4'), files.image], [{ path: files.image, pathKind: 'absolute' }])
    expect(res.assets).toHaveLength(0)
    const errors = Object.fromEntries(res.failures.map((f) => [f.name, f.error]))
    expect(errors['broken.mp4']).toMatch(/damaged|unsupported/i)
    expect(errors['notes.txt']).toMatch(/Unsupported/)
    expect(errors['nope.mp4']).toMatch(/not found/i)
    expect(errors['pic.png']).toMatch(/Already/)
  }, 30_000)

  it('refuses relative paths that escape the project folder', () => {
    expect(resolveAssetPath(projectDir, { path: '../../etc/passwd', pathKind: 'relative' })).toBeNull()
    expect(resolveAssetPath(projectDir, { path: 'relative/not-absolute', pathKind: 'absolute' })).toBeNull()
  })

  it('detects missing media, then relinks it to a moved file', async () => {
    const { assets } = await svc.importFiles(projectDir, [files.audio], [])
    const a = assets[0]
    const moved = path.join(root, 'external', 'moved-voice.wav')
    await fs.rename(files.audio, moved)

    const r1 = await svc.refresh(projectDir, [a], [])
    expect(r1.missing).toEqual([a.id])
    expect(r1.thumbs[a.id]).toBeTruthy()

    const relinked = await svc.relink(projectDir, a, moved)
    expect(relinked.asset.id).toBe(a.id)
    expect(relinked.asset.path).toBe(moved)
    expect(relinked.durationDiffers).toBe(false)
    expect(relinked.asset.thumbnail).toBe(`assets/thumbnails/${a.id}.png`)
    expect((await svc.refresh(projectDir, [relinked.asset], [a.id])).missing).toEqual([])
  }, 30_000)

  it('refuses to relink to a different kind of media', async () => {
    const { assets } = await svc.importFiles(projectDir, [files.mp3], [])
    await expect(svc.relink(projectDir, { ...assets[0], kind: 'video' }, files.mp3)).rejects.toThrow(/audio/)
  }, 30_000)

  it('generates a 540p proxy and verifies it with ffprobe', async () => {
    const { assets } = await svc.importFiles(projectDir, [files.khmerVideo.replace('វីដេអូ test', 'clip')], [{ path: files.video, pathKind: 'absolute' }])
    expect(assets).toHaveLength(0) // already imported -> nothing new
    const v = (await svc.importFiles(projectDir, [files.video], [])).assets[0]
    const rel = await svc.makeProxy(projectDir, v)
    expect(rel).toBe(`assets/proxies/${v.id}.mp4`)
    const out = JSON.parse(execFileSync(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_streams', path.join(projectDir, rel)]).toString())
    const vs = out.streams.find((s: { codec_type: string }) => s.codec_type === 'video')
    expect([vs.height, vs.codec_name]).toEqual([540, 'h264'])
    expect((await fs.readdir(path.join(projectDir, 'assets/proxies'))).some((n) => n.includes('.tmp.'))).toBe(false)
  }, 60_000)

  it('can cancel a running proxy without leaving partial files', async () => {
    const big = path.join(root, 'external', 'long.mp4')
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '40', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', big])
    const v = (await svc.importFiles(projectDir, [big], [])).assets[0]
    const job = svc.makeProxy(projectDir, v)
    await new Promise((r) => setTimeout(r, 300))
    svc.cancelProxy(v.id)
    await expect(job).rejects.toThrow(/cancelled/i)
    const left = await fs.readdir(path.join(projectDir, 'assets/proxies'))
    expect(left.some((n) => n.startsWith(v.id))).toBe(false)
  }, 90_000)
})

describe('waveforms', () => {
  it('computes loudness peaks that follow the audio and caches them', async () => {
    // 1 s of silence then 1 s of a loud tone
    const wav = path.join(root, 'external', 'quiet-then-loud.wav')
    ff(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-filter_complex', '[0:a]atrim=0:1[s];[1:a]atrim=0:1[t];[s][t]concat=n=2:v=0:a=1', wav])
    const a = (await svc.importFiles(projectDir, [wav], [])).assets[0]
    const peaks = (await svc.waveform(projectDir, a))!
    expect(peaks.length).toBeGreaterThanOrEqual(98)
    expect(peaks.length).toBeLessThanOrEqual(102)
    const avg = (from: number, to: number) => peaks.slice(from, to).reduce((x, y) => x + y, 0) / (to - from)
    expect(avg(5, 45)).toBeLessThan(5) // first second: silence
    expect(avg(55, 95)).toBeGreaterThan(60) // second second: tone (ffmpeg's sine is about -18 dBFS)
    const cached = path.join(projectDir, 'assets/waveforms', `${a.id}-${a.sizeBytes}.peaks`)
    expect((await fs.stat(cached)).size).toBe(peaks.length)
    expect(Array.from((await svc.waveform(projectDir, a))!)).toEqual(Array.from(peaks)) // served from cache
  }, 30_000)
  it('returns null for non-audio and missing files', async () => {
    const v = (await svc.importFiles(projectDir, [files.inside], [])).assets[0]
    expect(await svc.waveform(projectDir, v)).toBeNull()
    expect(await svc.waveform(projectDir, { ...v, kind: 'audio', path: '/nope.wav', pathKind: 'absolute' })).toBeNull()
  })
})

describe('schema migration', () => {
  it('upgrades a Phase 1 (v1) project by adding an empty media library and timeline', () => {
    const { media: _media, clips: _clips, subtitles: _subs, ...v1 } = createEmptyProject('Old')
    void _media
    void _clips
    void _subs
    const migrated = migrateProject({ ...v1, schemaVersion: 1 })
    expect(migrated.schemaVersion).toBe(6)
    expect(migrated.subtitles).toEqual([])
    expect(migrated.tracks.every((t) => t.volume === 100)).toBe(true)
    expect(migrated.media).toEqual([])
    expect(migrated.clips).toEqual([])
    expect(migrated.name).toBe('Old')
  })
})
