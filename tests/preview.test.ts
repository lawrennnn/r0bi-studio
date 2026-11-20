import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createEmptyProject, type Clip, type MediaAsset, type Project } from '../shared/project'
import { computeLayers, previewUrl, sourceSeconds } from '../shared/preview'
import { timelineEnd } from '../shared/timeline'
import { handleMediaRequest, MediaRegistry, parseRange, serveFile } from '../electron/media/protocol'

const asset = (id: string, kind: MediaAsset['kind'], over: Partial<MediaAsset> = {}): MediaAsset => ({
  id, kind, name: `${id}.x`, path: `/m/${id}.x`, pathKind: 'absolute', sizeBytes: 1, durationMs: kind === 'image' ? 0 : 10_000,
  width: 1920, height: 1080, fpsNum: 30, fpsDen: 1, videoCodec: 'h264', audioCodec: 'aac', sampleRate: 48000, channels: 2,
  thumbnail: null, proxy: null, importedAt: '', ...over
})

function project(): Project {
  const p = createEmptyProject('P') // tracks: Overlay 1, Subtitles 1, Video 1, Video 2, Audio 1, Audio 2
  p.media = [asset('v', 'video'), asset('i', 'image'), asset('a', 'audio')]
  const t = (name: string) => p.tracks.find((x) => x.name === name)!.id
  const clip = (id: string, trackName: string, assetId: string, start: number, dur: number, srcIn = 0): Clip => ({ id, trackId: t(trackName), assetId, startFrame: start, sourceInFrame: srcIn, durationFrames: dur, volume: 100, fadeInFrames: 0, fadeOutFrames: 0, videoFadeInFrames: 0, videoFadeOutFrames: 0 })
  p.clips = [
    clip('base', 'Video 2', 'v', 0, 300),
    clip('top', 'Video 1', 'v', 100, 100, 30),
    clip('logo', 'Overlay 1', 'i', 0, 150),
    clip('music', 'Audio 1', 'a', 0, 300),
    clip('later', 'Video 1', 'v', 230, 60)
  ]
  return p
}

describe('computeLayers', () => {
  it('stacks tracks with the first timeline row on top', () => {
    const layers = computeLayers(project(), 120)
    const active = layers.filter((l) => l.active).map((l) => l.clip.id)
    expect(active).toEqual(['music', 'base', 'top', 'logo']) // ascending z: audio row, Video 2, Video 1, Overlay 1
    const z = Object.fromEntries(layers.map((l) => [l.clip.id, l.z]))
    expect(z.logo).toBeGreaterThan(z.top)
    expect(z.top).toBeGreaterThan(z.base)
  })
  it('only includes clips under the playhead plus upcoming ones within the lookahead', () => {
    const p = project()
    expect(computeLayers(p, 5).map((l) => l.clip.id).sort()).toEqual(['base', 'logo', 'music']) // 'top' starts at 100, beyond the 60-frame lookahead
    const early = computeLayers(p, 45).find((l) => l.clip.id === 'top')
    expect(early && !early.active).toBe(true) // within lookahead: preloaded but not shown
    expect(computeLayers(p, 200).some((l) => l.clip.id === 'later' && !l.active)).toBe(true)
    expect(computeLayers(p, 200).some((l) => l.clip.id === 'top')).toBe(false) // ended at 200 (exclusive)
    expect(computeLayers(p, 299).some((l) => l.clip.id === 'later')).toBe(false) // ended at 290
  })
  it('hides picture for hidden tracks but keeps their sound, and honours mute and overlays', () => {
    const p = project()
    p.tracks.find((t) => t.name === 'Video 2')!.visible = false
    p.tracks.find((t) => t.name === 'Video 1')!.muted = true
    const by = Object.fromEntries(computeLayers(p, 120).map((l) => [l.clip.id, l]))
    expect(by.base.visible).toBe(false)
    expect(by.base.muted).toBe(false)
    expect(by.top.muted).toBe(true)
    expect(by.logo.muted).toBe(true) // overlay audio is not previewed
    expect(by.music.visible).toBe(false) // audio has no picture
    expect(by.music.kind).toBe('audio')
  })
  it('ignores subtitle tracks and dangling references', () => {
    const p = project()
    p.clips.push({ id: 'orphan', trackId: 'nope', assetId: 'v', startFrame: 0, sourceInFrame: 0, durationFrames: 10, volume: 100, fadeInFrames: 0, fadeOutFrames: 0, videoFadeInFrames: 0, videoFadeOutFrames: 0 })
    expect(computeLayers(p, 5).some((l) => l.clip.id === 'orphan')).toBe(false)
  })
})

describe('time mapping and urls', () => {
  it('maps timeline frames to source seconds', () => {
    const c: Clip = { id: 'c', trackId: 't', assetId: 'a', startFrame: 100, sourceInFrame: 30, durationFrames: 60, volume: 100, fadeInFrames: 0, fadeOutFrames: 0, videoFadeInFrames: 0, videoFadeOutFrames: 0 }
    expect(sourceSeconds(c, 100, 30)).toBe(1)
    expect(sourceSeconds(c, 130, 30)).toBe(2)
    expect(sourceSeconds(c, 50, 30)).toBe(1) // before the clip clamps to its first frame
    expect(sourceSeconds(c, 999, 30)).toBeCloseTo((30 + 59) / 30)
  })
  it('uses the proxy only when asked and available', () => {
    expect(previewUrl({ id: 'x', kind: 'video', proxy: 'assets/proxies/x.mp4' }, true)).toBe('r0bi-media://proxy/x')
    expect(previewUrl({ id: 'x', kind: 'video', proxy: 'assets/proxies/x.mp4' }, false)).toBe('r0bi-media://asset/x')
    expect(previewUrl({ id: 'x', kind: 'video', proxy: null }, true)).toBe('r0bi-media://asset/x')
  })
  it('finds where playback stops', () => {
    expect(timelineEnd(project())).toBe(300)
    expect(timelineEnd({ clips: [] })).toBe(0)
  })
})

describe('parseRange', () => {
  it('handles open, closed, suffix and invalid ranges', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=100-', 100)).toBe('invalid')
    expect(parseRange('bytes=20-10', 100)).toBe('invalid')
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull()
    expect(parseRange('garbage', 100)).toBeNull()
  })
})

describe('media protocol', () => {
  let dir: string
  const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'r0bi-proto-'))
    await fs.mkdir(path.join(dir, 'assets/proxies'), { recursive: true })
    await fs.writeFile(path.join(dir, 'clip.mp4'), data)
    await fs.writeFile(path.join(dir, 'assets/proxies/v.mp4'), data.subarray(0, 100))
    await fs.writeFile(path.join(dir, 'empty.png'), '')
  })
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  const bytes = async (r: Response) => Buffer.from(await r.arrayBuffer())

  it('serves a whole file, ranges, suffix ranges and HEAD', async () => {
    const f = path.join(dir, 'clip.mp4')
    const full = await serveFile(f, null)
    expect([full.status, full.headers.get('content-type'), full.headers.get('accept-ranges'), full.headers.get('content-length')]).toEqual([200, 'video/mp4', 'bytes', '1000'])
    expect((await bytes(full)).equals(data)).toBe(true)

    const part = await serveFile(f, 'bytes=100-199')
    expect([part.status, part.headers.get('content-range'), part.headers.get('content-length')]).toEqual([206, 'bytes 100-199/1000', '100'])
    expect((await bytes(part)).equals(data.subarray(100, 200))).toBe(true)

    const tail = await serveFile(f, 'bytes=-50')
    expect((await bytes(tail)).equals(data.subarray(950))).toBe(true)

    const head = await serveFile(f, null, 'HEAD')
    expect([head.status, head.headers.get('content-length')]).toEqual([200, '1000'])
    expect((await bytes(head)).length).toBe(0)
  })
  it('rejects bad ranges, missing files, directories and empty files sensibly', async () => {
    expect((await serveFile(path.join(dir, 'clip.mp4'), 'bytes=5000-')).status).toBe(416)
    expect((await serveFile(path.join(dir, 'nope.mp4'), null)).status).toBe(404)
    expect((await serveFile(dir, null)).status).toBe(404)
    expect((await serveFile(path.join(dir, 'empty.png'), null)).status).toBe(200)
  })
  it('only serves files registered in the library', async () => {
    const reg = new MediaRegistry()
    reg.update(dir, [asset('v', 'video', { path: 'clip.mp4', pathKind: 'relative', proxy: 'assets/proxies/v.mp4' })])
    const get = (url: string, range: string | null = null, method = 'GET') =>
      handleMediaRequest(reg, { url, method, headers: { get: (n: string) => (n.toLowerCase() === 'range' ? range : null) } })

    expect((await bytes(await get('r0bi-media://asset/v'))).equals(data)).toBe(true)
    expect((await bytes(await get('r0bi-media://proxy/v'))).length).toBe(100)
    expect((await get('r0bi-media://asset/v', 'bytes=0-9')).status).toBe(206)
    expect((await get('r0bi-media://asset/unknown')).status).toBe(404)
    expect((await get('r0bi-media://asset/..%2F..%2Fetc%2Fpasswd')).status).toBe(404)
    expect((await get('r0bi-media://other/v')).status).toBe(404)
    expect((await get('r0bi-media://asset/v', null, 'POST')).status).toBe(405)
    reg.update(dir, [asset('v', 'video', { path: '../outside.mp4', pathKind: 'relative' })])
    expect((await get('r0bi-media://asset/v')).status).toBe(404) // relative path escaping the project is refused
  })
})
