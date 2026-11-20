import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createEmptyProject, type Clip, type MediaAsset, type Project } from '../shared/project'
import { assembleScenes, DEFAULT_RECIPE } from '../shared/automation'
import { DEFAULT_EFFECTS } from '../shared/project'
import { buildRenderPlan, buildSubtitleConcat, encodeArgs, outputSize, DEFAULT_EXPORT_SETTINGS, type ExportSettings } from '../shared/render'
import { getTool } from '../electron/media/binaries'
import { MediaService } from '../electron/media/mediaService'
import { ProjectManager } from '../electron/projectManager'
import { detectNvenc, RenderCancelled, resolveEncoder, runRender, verifyOutput } from '../electron/export/renderer'

let root: string
let projectDir: string
let ffmpeg = ''
let ffprobe = ''
const svc = new MediaService()
const src: Record<string, string> = {}
const asset: Record<string, MediaAsset> = {}
let blank = ''
let cueImg = ''

const ff = (args: string[]) => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args])

/** RGB of one pixel at time t. */
function pixel(file: string, t: number, x: number, y: number): [number, number, number] {
  const out = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'])
  return [out[0], out[1], out[2]]
}
/** Peak level (dBFS) of a stretch of audio. */
function peakDb(file: string, from: number, len: number): number {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-ss', String(from), '-t', String(len), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
  const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr)
  return m ? (m[1] === '-inf' ? -200 : Number(m[1])) : -200
}

const settings = (over: Partial<ExportSettings> = {}): ExportSettings => ({ ...DEFAULT_EXPORT_SETTINGS, resolution: 'project', quality: 'draft', encoder: 'cpu', ...over })

function makeProject(): Project {
  const p = createEmptyProject('Render test')
  p.settings = { width: 640, height: 360, fps: 30 }
  p.media = Object.values(asset)
  return p
}
const track = (p: Project, name: string) => p.tracks.find((t) => t.name === name)!
let counter = 0
function clip(p: Project, trackName: string, a: MediaAsset, start: number, dur: number, extra: Partial<Clip> = {}): Clip {
  const c: Clip = { id: `c${++counter}`, trackId: track(p, trackName).id, assetId: a.id, startFrame: start, sourceInFrame: 0, durationFrames: dur, volume: 100, fadeInFrames: 0, fadeOutFrames: 0, videoFadeInFrames: 0, videoFadeOutFrames: 0, ...extra }
  p.clips.push(c)
  return c
}

let jobNo = 0
async function render(p: Project, over: Partial<Parameters<typeof runRender>[0]> = {}, s: ExportSettings = settings()) {
  const dir = await fs.mkdtemp(path.join(root, 'job-'))
  const outFile = path.join(root, `out-${++jobNo}.mp4`)
  const progress: number[] = []
  const res = await runRender({ ffmpeg, ffprobe, project: p, projectDir, settings: s, encoder: 'cpu', outFile, tempDir: dir, subtitleImages: {}, blankImage: null, onProgress: (f) => progress.push(f), ...over })
  return { ...res, progress }
}

beforeAll(async () => {
  const [a, b] = await Promise.all([getTool('ffmpeg'), getTool('ffprobe')])
  expect(a.path && b.path).toBeTruthy()
  ffmpeg = a.path as string
  ffprobe = b.path as string
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'r0bi render test '))
  projectDir = (await new ProjectManager().create(root, 'P')).dir
  const media = path.join(root, 'media')
  await fs.mkdir(media)
  const v = (name: string, color: string, secs: number, audio: boolean) => {
    src[name] = path.join(media, `${name}.mp4`)
    ff(['-f', 'lavfi', '-i', `color=c=${color}:s=640x360:r=30:d=${secs}`, ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100'] : []), '-t', String(secs), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : []), src[name]])
  }
  v('blue', 'blue', 4, true)
  v('green', 'green', 3, false)
  src.logo = path.join(media, 'logo.png')
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=100x100', '-frames:v', '1', src.logo])
  src.tone = path.join(media, 'tone.wav')
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '5', src.tone])
  src.tone2 = path.join(media, 'tone2.wav')
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '5', src.tone2])
  const imported = await svc.importFiles(projectDir, Object.values(src), [])
  expect(imported.failures).toEqual([])
  for (const a of imported.assets) asset[a.name.replace(/\.\w+$/, '')] = a

  const sub = path.join(root, 'sub images')
  await fs.mkdir(sub)
  blank = path.join(sub, 'blank.png')
  cueImg = path.join(sub, 'cue.png')
  ff(['-f', 'lavfi', '-i', 'color=c=black@0.0:s=640x360:r=1,format=rgba', '-frames:v', '1', blank])
  ff(['-f', 'lavfi', '-i', 'color=c=red@0.5:s=200x100,format=rgba,pad=640:360:100:100:color=0x00000000', '-frames:v', '1', cueImg])
}, 120_000)

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('export planning (pure)', () => {
  it('sizes output by the shorter side and keeps dimensions even', () => {
    expect(outputSize({ width: 1920, height: 1080, fps: 30 }, '720p')).toEqual({ width: 1280, height: 720 })
    expect(outputSize({ width: 1280, height: 720, fps: 30 }, '1080p')).toEqual({ width: 1920, height: 1080 })
    expect(outputSize({ width: 1080, height: 1920, fps: 30 }, '720p')).toEqual({ width: 720, height: 1280 })
    expect(outputSize({ width: 641, height: 361, fps: 30 }, 'project')).toEqual({ width: 642, height: 362 })
  })
  it('builds a stacked, timed filter graph and refuses an empty timeline', () => {
    const p = makeProject()
    expect(() => buildRenderPlan(p, { width: 640, height: 360, resolvePath: () => '/x', subtitleLists: {} })).toThrow(/empty/)
    clip(p, 'Video 2', asset.blue, 0, 90)
    clip(p, 'Video 1', asset.green, 30, 60)
    const plan = buildRenderPlan(p, { width: 640, height: 360, resolvePath: (a) => `/m/${a.name}`, subtitleLists: {} })
    expect(plan.totalFrames).toBe(90)
    expect(plan.filter).toMatch(/^color=c=black:s=640x360:r=30:d=3\.000000,format=rgba\[b0\]/)
    expect(plan.filter.indexOf('/m/')).toBe(-1) // paths are inputs, not part of the filter text
    // bottom layer (Video 2 = blue) is composited before the top layer (Video 1 = green)
    expect(plan.inputs.join(' ')).toMatch(/blue\.mp4.*green\.mp4/)
    expect(plan.filter).toMatch(/\[b0\]\[v0\]overlay=.*\[b1\];.*\[b1\]\[v1\]overlay=.*\[b2\]/)
    expect(plan.filter).toMatch(/\[b2\]format=yuv420p\[vout\]/)
    expect(plan.filter).toContain('[aout]')
  })
  it('writes a subtitle concat list with gaps, a repeated final file, and forward slashes', () => {
    const list = buildSubtitleConcat([{ startFrame: 30, durationFrames: 30, imagePath: 'C:\\tmp\\it\'s.png' }], 30, 120, 'C:\\tmp\\blank.png')
    expect(list).toBe(
      "ffconcat version 1.0\nfile 'C:/tmp/blank.png'\nduration 1.000000\nfile 'C:/tmp/it'\\''s.png'\nduration 1.000000\nfile 'C:/tmp/blank.png'\nduration 2.000000\nfile 'C:/tmp/blank.png'\n"
    )
  })
  it('chooses encoder arguments', () => {
    expect(encodeArgs({ encoder: 'cpu', quality: 'high' }).join(' ')).toContain('-c:v libx264 -preset slow -crf 18')
    expect(encodeArgs({ encoder: 'nvenc', quality: 'standard' }).join(' ')).toContain('-c:v h264_nvenc')
    expect(resolveEncoder('auto', true)).toBe('nvenc')
    expect(resolveEncoder('auto', false)).toBe('cpu')
    expect(resolveEncoder('nvenc', false)).toBe('cpu')
    expect(resolveEncoder('cpu', true)).toBe('cpu')
  })
})

describe('real renders', () => {
  it('renders one clip to a verified H.264/AAC MP4 of the right size and length', async () => {
    const p = makeProject()
    clip(p, 'Video 1', asset.blue, 0, 90)
    const r = await render(p)
    expect(r.verification).toMatchObject({ ok: true, width: 640, height: 360, videoCodec: 'h264', audioCodec: 'aac' })
    expect(r.verification.durationSec).toBeGreaterThan(2.8)
    expect(r.verification.durationSec).toBeLessThan(3.3)
    expect(r.verification.fps).toBeCloseTo(30, 1)
    const [red, , blue] = pixel(r.outFile, 1, 320, 180)
    expect(blue).toBeGreaterThan(150)
    expect(red).toBeLessThan(80)
    expect(r.progress.at(-1)).toBe(1)
    expect(r.progress.every((x, i, a) => i === 0 || x >= a[i - 1])).toBe(true)
    await expect(fs.access(`${r.outFile}.partial`)).rejects.toThrow()
  }, 60_000)

  it('stacks tracks (first row on top), respects start times, and shows lower layers outside a clip', async () => {
    const p = makeProject()
    clip(p, 'Video 2', asset.blue, 0, 120) // bottom, 0-4 s
    clip(p, 'Video 1', asset.green, 30, 60) // top, 1-3 s
    const r = await render(p)
    const at = (t: number) => pixel(r.outFile, t, 320, 180)
    expect(at(0.5)[2]).toBeGreaterThan(150) // blue only
    expect(at(2)[1]).toBeGreaterThan(80) // green covers blue
    expect(at(2)[2]).toBeLessThan(80)
    expect(at(3.5)[2]).toBeGreaterThan(150) // blue again
  }, 60_000)

  it('letterboxes with transparent bars, lets lower layers show through, and hides hidden tracks', async () => {
    const p = makeProject()
    clip(p, 'Video 2', asset.blue, 0, 90)
    clip(p, 'Overlay 1', asset.logo, 0, 90) // 100x100 red square, fitted to 360x360 in the middle
    const r = await render(p)
    const centre = pixel(r.outFile, 1, 320, 180)
    const bar = pixel(r.outFile, 1, 20, 180)
    expect(centre[0]).toBeGreaterThan(180) // red logo on top
    expect(bar[2]).toBeGreaterThan(150) // left bar: video below shows through
    expect(bar[0]).toBeLessThan(80)

    track(p, 'Overlay 1').visible = false
    const hidden = await render(p)
    expect(pixel(hidden.outFile, 1, 320, 180)[2]).toBeGreaterThan(150)
  }, 60_000)

  it('applies volume, track level, fades, start delay and muting to the sound', async () => {
    const p = makeProject()
    clip(p, 'Audio 1', asset.tone, 60, 90, { volume: 50, fadeInFrames: 30 }) // starts at 2 s, ends at 5 s, fades in over 1 s
    const r = await render(p)
    expect(peakDb(r.outFile, 0, 1.8)).toBeLessThan(-60) // silence before the clip
    const full = peakDb(r.outFile, 3.5, 1) // after the fade
    expect(full).toBeGreaterThan(-26)
    expect(full).toBeLessThan(-22) // sine at -18 dB x 50% = -24 dB
    expect(peakDb(r.outFile, 2.0, 0.15)).toBeLessThan(full - 6) // inside the fade-in

    track(p, 'Audio 1').volume = 50
    const quieter = await render(p)
    expect(peakDb(quieter.outFile, 3.5, 1)).toBeLessThan(full - 4.5) // another -6 dB from the track level

    track(p, 'Audio 1').muted = true
    const muted = await render(p)
    expect(peakDb(muted.outFile, 3.5, 1)).toBeLessThan(-60)
    expect(muted.verification.audioCodec).toBe('aac') // still has an audio track
  }, 90_000)

  it('mixes simultaneous clips at their true levels (no hidden 1/N scaling)', async () => {
    const p = makeProject()
    clip(p, 'Audio 1', asset.tone, 0, 90)
    const single = await render(p)
    const one = peakDb(single.outFile, 0.5, 2)
    clip(p, 'Audio 2', asset.tone2, 0, 90) // identical tone, in phase: sums to +6 dB
    const both = await render(p)
    const two = peakDb(both.outFile, 0.5, 2)
    expect(one).toBeGreaterThan(-19.5)
    expect(one).toBeLessThan(-16.5)
    expect(two - one).toBeGreaterThan(4.8)
    expect(two - one).toBeLessThan(7.2)
  }, 90_000)

  it('keeps the sound of video clips, and leaves overlay-track sound out like the preview', async () => {
    const p = makeProject()
    clip(p, 'Video 1', asset.blue, 0, 60)
    const withSound = await render(p)
    expect(peakDb(withSound.outFile, 0.5, 1)).toBeGreaterThan(-25)
    const q = makeProject()
    clip(q, 'Overlay 1', asset.blue, 0, 60)
    const overlayOnly = await render(q)
    expect(peakDb(overlayOnly.outFile, 0.5, 1)).toBeLessThan(-60)
  }, 60_000)

  it('burns subtitles at the right time with transparency, from a path with spaces', async () => {
    const p = makeProject()
    clip(p, 'Video 1', asset.blue, 0, 120)
    p.subtitles.push({ id: 'cue1', trackId: track(p, 'Subtitles 1').id, startFrame: 30, durationFrames: 30, text: 'x' }) // 1-2 s
    const r = await render(p, { subtitleImages: { cue1: cueImg }, blankImage: blank })
    const inside = pixel(r.outFile, 1.5, 150, 150) // 50% red over blue
    const before = pixel(r.outFile, 0.5, 150, 150)
    const after = pixel(r.outFile, 2.5, 150, 150)
    expect(inside[0]).toBeGreaterThan(90)
    expect(inside[2]).toBeGreaterThan(90) // still some blue: blended, not opaque
    expect(inside[2]).toBeLessThan(200)
    expect(before[0]).toBeLessThan(60)
    expect(after[0]).toBeLessThan(60)
    expect(pixel(r.outFile, 1.5, 500, 300)[0]).toBeLessThan(60) // outside the box
  }, 60_000)

  it('hides subtitles on hidden tracks and can export subtitles alone', async () => {
    const p = makeProject()
    p.subtitles.push({ id: 'cue1', trackId: track(p, 'Subtitles 1').id, startFrame: 0, durationFrames: 60, text: 'x' })
    const r = await render(p, { subtitleImages: { cue1: cueImg }, blankImage: blank })
    expect(r.verification.ok).toBe(true)
    expect(pixel(r.outFile, 0.5, 150, 150)[0]).toBeGreaterThan(60) // red box over black
    track(p, 'Subtitles 1').visible = false
    const hidden = await render(p, { subtitleImages: { cue1: cueImg }, blankImage: blank })
    expect(pixel(hidden.outFile, 0.5, 150, 150)[0]).toBeLessThan(30)
  }, 60_000)

  it('cuts at the exact source in-point (frame-accurate seeking)', async () => {
    const rgb = path.join(root, 'media', 'rgb.mp4') // red 0-1 s, green 1-2 s, blue 2-3 s
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=green:s=640x360:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=30:d=1', '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', rgb])
    const a = (await svc.importFiles(projectDir, [rgb], [])).assets[0]
    const p = makeProject()
    p.media = [...p.media, a]
    clip(p, 'Video 1', a, 0, 30, { sourceInFrame: 30 }) // second 1-2 of the source: green
    clip(p, 'Video 1', a, 30, 30, { sourceInFrame: 60 }) // second 2-3: blue
    clip(p, 'Video 1', a, 60, 30, { sourceInFrame: 0 }) // second 0-1: red
    const r = await render(p)
    const mid = (t: number) => pixel(r.outFile, t, 320, 180)
    expect(mid(0.5)[1]).toBeGreaterThan(100) // green
    expect(mid(0.5)[0]).toBeLessThan(80)
    expect(mid(1.5)[2]).toBeGreaterThan(150) // blue
    expect(mid(2.5)[0]).toBeGreaterThan(150) // red
    expect(mid(0.95)[1]).toBeGreaterThan(100) // last frames before the cut
    expect(mid(1.03)[2]).toBeGreaterThan(150) // and straight after it
  }, 60_000)

  it('fades a clip in from black, to black, and dissolves over a lower layer', async () => {
    const p = makeProject()
    clip(p, 'Video 1', asset.blue, 0, 90, { videoFadeInFrames: 30, videoFadeOutFrames: 30 }) // 3 s: fade in 0-1 s, fade out 2-3 s
    const r = await render(p)
    const blue = (t: number) => pixel(r.outFile, t, 320, 180)[2]
    expect(blue(0.05)).toBeLessThan(60) // starts black
    expect(blue(0.5)).toBeGreaterThan(70) // part-way
    expect(blue(0.5)).toBeLessThan(200)
    expect(blue(1.5)).toBeGreaterThan(220) // fully visible in the middle
    expect(blue(2.5)).toBeGreaterThan(70)
    expect(blue(2.5)).toBeLessThan(200)
    expect(blue(2.95)).toBeLessThan(70) // ends black

    // Over a lower layer the fade is a dissolve: green shows through while the top clip fades in.
    const q = makeProject()
    clip(q, 'Video 2', asset.green, 0, 90)
    clip(q, 'Video 1', asset.blue, 0, 90, { videoFadeInFrames: 60 })
    const d = await render(q)
    const early = pixel(d.outFile, 0.1, 320, 180)
    const late = pixel(d.outFile, 2.0, 320, 180)
    expect(early[1]).toBeGreaterThan(90) // mostly green at first
    expect(early[2]).toBeLessThan(120)
    expect(late[2]).toBeGreaterThan(220) // fully blue once the fade is over
  }, 90_000)

  it('renders an automatically assembled project: scenes in order, dips between them, narration and quiet music', async () => {
    const p = makeProject()
    const r0 = assembleScenes(p, { sceneAssetIds: [asset.blue.id, asset.green.id, asset.logo.id], narrationAssetId: asset.tone.id, musicAssetId: asset.tone2.id, mode: 'replace' }, { ...DEFAULT_RECIPE, fadeSeconds: 0.5, stillSeconds: 5, musicVolume: 20, musicFadeInSeconds: 0, musicFadeOutSeconds: 0 })
    expect(r0.ok).toBe(true)
    if (!r0.ok) return
    p.tracks = r0.tracks
    p.clips = r0.clips
    const r = await render(p)
    expect(r.verification.ok).toBe(true)
    expect(r.verification.durationSec).toBeGreaterThan(11.7) // 4 + 3 + 5 s
    expect(r.verification.durationSec).toBeLessThan(12.4)
    const at = (t: number, x = 320, y = 180) => pixel(r.outFile, t, x, y)
    expect(at(2)[2]).toBeGreaterThan(150) // blue scene
    expect(at(5.5)[1]).toBeGreaterThan(80) // green scene
    expect(at(9.5)[0]).toBeGreaterThan(180) // red still image
    const dip = at(3.97)
    expect(dip[2]).toBeLessThan(120) // the blue scene has faded most of the way out
    expect(peakDb(r.outFile, 1, 2)).toBeGreaterThan(-19) // narration and music together
    expect(peakDb(r.outFile, 7, 3)).toBeLessThan(-60) // narration (5 s) and music (5 s) are over after 5 s
  }, 90_000)

  describe('picture effects', () => {
    let gradient: MediaAsset
    beforeAll(async () => {
      // Horizontal gradient: the red value at an output x tells us which source x is showing there.
      const file = path.join(root, 'media', 'gradient.mp4')
      ff(['-f', 'lavfi', '-i', 'nullsrc=s=640x360:r=30:d=3,format=rgb24,geq=r=X*255/640:g=0:b=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file])
      gradient = (await svc.importFiles(projectDir, [file], [])).assets[0]
    }, 60_000)
    const withGradient = (extra: Partial<Clip>) => {
      const p = makeProject()
      p.media = [...p.media, gradient]
      clip(p, 'Video 1', gradient, 0, 90, extra)
      return p
    }
    const red = (file: string, t: number, x: number) => pixel(file, t, x, 180)[0]

    it('halves the opacity so the layer below shows through', async () => {
      const p = makeProject()
      clip(p, 'Video 2', asset.green, 0, 90)
      clip(p, 'Video 1', asset.blue, 0, 90, { effects: { ...DEFAULT_EFFECTS, opacity: 50 } })
      const r = await render(p)
      const [, g, b] = pixel(r.outFile, 1, 320, 180)
      expect(b).toBeGreaterThan(90) // half blue
      expect(b).toBeLessThan(190)
      expect(g).toBeGreaterThan(40) // and half green
    }, 60_000)

    it('zooms about the centre, steadily from start to end', async () => {
      const r = await render(withGradient({ effects: { ...DEFAULT_EFFECTS, scaleStart: 100, scaleEnd: 200 } }))
      expect(r.verification).toMatchObject({ ok: true, width: 640, height: 360 })
      // Zoom z shows source x from 320*(1-1/z) onwards at the left edge: 0 at 1x, 160 at 2x (red 64).
      expect(red(r.outFile, 0.05, 2)).toBeLessThan(8)
      const mid = red(r.outFile, 1.5, 2) // about 1.5x: source x of about 107 -> red 42
      expect(mid).toBeGreaterThan(30)
      expect(mid).toBeLessThan(56)
      expect(red(r.outFile, 2.9, 2)).toBeGreaterThan(54) // about 2x
      expect(red(r.outFile, 2.9, 2)).toBeLessThan(72)
      expect(red(r.outFile, 2.9, 637)).toBeGreaterThan(180) // right edge shows source x of about 480 -> red 191
    }, 90_000)

    it('moves the picture by a share of the frame, fixed or animated, showing what is below at the edge', async () => {
      const fixed = await render(withGradient({ effects: { ...DEFAULT_EFFECTS, posStartX: 50, posEndX: 50 } }))
      expect(red(fixed.outFile, 1, 100)).toBeLessThan(6) // left half is now empty (black)
      expect(red(fixed.outFile, 1, 500)).toBeGreaterThan(55) // right half shows source x of 180 -> red 72
      expect(red(fixed.outFile, 1, 500)).toBeLessThan(90)

      const slide = await render(withGradient({ effects: { ...DEFAULT_EFFECTS, posStartX: 0, posEndX: 50 } }))
      expect(red(slide.outFile, 0.05, 100)).toBeGreaterThan(30) // starts in place
      expect(red(slide.outFile, 2.9, 100)).toBeLessThan(6) // slid off to the right by the end
    }, 120_000)
  })

  it('scales to a chosen resolution', async () => {
    const p = makeProject()
    clip(p, 'Video 1', asset.green, 0, 30)
    const r = await render(p, {}, settings({ resolution: '720p' }))
    expect(r.verification).toMatchObject({ ok: true, width: 1280, height: 720 })
  }, 60_000)

  it('uses a filter script file for very long graphs', async () => {
    const p = makeProject()
    clip(p, 'Video 1', asset.green, 0, 30)
    const dir = await fs.mkdtemp(path.join(root, 'job-'))
    const r = await render(p, { filterLimit: 50, tempDir: dir })
    expect(r.verification.ok).toBe(true)
    expect((await fs.stat(path.join(dir, 'filter.txt'))).size).toBeGreaterThan(50)
  }, 60_000)

  it('cancels mid-render and leaves no partial or final file', async () => {
    const big = path.join(root, 'media', 'long.mp4')
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', big])
    const a = (await svc.importFiles(projectDir, [big], [])).assets[0]
    const p = makeProject()
    p.media = [...p.media, a]
    clip(p, 'Video 1', a, 0, 1800)
    const ctl = new AbortController()
    const outFile = path.join(root, 'cancelled.mp4')
    const seen: number[] = []
    const job = runRender({
      ffmpeg, ffprobe, project: p, projectDir, settings: settings({ quality: 'high' }), encoder: 'cpu', outFile,
      tempDir: await fs.mkdtemp(path.join(root, 'job-')), subtitleImages: {}, blankImage: null, onProgress: (f) => { seen.push(f); if (f > 0.01) ctl.abort() }, signal: ctl.signal
    })
    await expect(job).rejects.toBeInstanceOf(RenderCancelled)
    await expect(fs.access(outFile)).rejects.toThrow()
    await expect(fs.access(`${outFile}.partial`)).rejects.toThrow()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)).toBeLessThan(1)
  }, 90_000)

  it('names missing media instead of failing mysteriously', async () => {
    const p = makeProject()
    const ghost: MediaAsset = { ...asset.blue, id: 'ghost', name: 'ghost.mp4', path: '/no/such/ghost.mp4', pathKind: 'absolute' }
    p.media.push(ghost)
    clip(p, 'Video 1', ghost, 0, 30)
    await expect(render(p)).rejects.toThrow(/missing: ghost\.mp4/)
  })

  it('verification reports a wrong size, frame rate or length', async () => {
    const p = makeProject()
    clip(p, 'Video 1', asset.green, 0, 30)
    const r = await render(p)
    const bad = await verifyOutput(ffprobe, r.outFile, { width: 1920, height: 1080, fps: 60, seconds: 10 })
    expect(bad.ok).toBe(false)
    expect(bad.problems.length).toBe(3)
  }, 60_000)

  it('detects that this machine has no usable NVENC GPU encoder', async () => {
    expect(await detectNvenc(ffmpeg)).toBe(false)
  })
})
