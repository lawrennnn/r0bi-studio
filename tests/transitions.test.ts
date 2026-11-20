import { beforeEach, describe, expect, it } from 'vitest'
import { clipOpacity } from '../shared/audio'
import { createEmptyProject, migrateProject, type Clip, type MediaAsset } from '../shared/project'
import { normalizeFades, rescaleClips, splitClip, validateClips } from '../shared/timeline'
import { buildRenderPlan } from '../shared/render'
import { useProjectStore } from '../src/store/projectStore'
import { useUiStore } from '../src/store/uiStore'
import { timeline } from '../src/store/timelineActions'

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'c', trackId: 't', assetId: 'a', startFrame: 100, sourceInFrame: 0, durationFrames: 100, volume: 100, fadeInFrames: 0, fadeOutFrames: 0, videoFadeInFrames: 0, videoFadeOutFrames: 0, ...over
})
const asset = (id: string, kind: MediaAsset['kind'], ms = 10_000): MediaAsset => ({
  id, kind, name: `${id}.x`, path: `/${id}.x`, pathKind: 'absolute', sizeBytes: 1, durationMs: kind === 'image' ? 0 : ms,
  width: 640, height: 360, fpsNum: 30, fpsDen: 1, videoCodec: kind === 'audio' ? null : 'h264', audioCodec: kind === 'image' ? null : 'aac',
  sampleRate: 48000, channels: 1, thumbnail: null, proxy: null, importedAt: ''
})

describe('picture fades', () => {
  it('ramps opacity in and out and is zero outside the clip', () => {
    const c = clip({ videoFadeInFrames: 10, videoFadeOutFrames: 20 })
    expect(clipOpacity(c, 99)).toBe(0)
    expect(clipOpacity(c, 100)).toBeCloseTo(0.05)
    expect(clipOpacity(c, 150)).toBe(1)
    expect(clipOpacity(c, 199)).toBeCloseTo(0.025)
    expect(clipOpacity(clip(), 150)).toBe(1) // no fades: fully visible
  })
  it('keeps picture fades inside the clip, splits them to the right halves, and rescales them', () => {
    expect(normalizeFades(clip({ durationFrames: 30, videoFadeInFrames: 25, videoFadeOutFrames: 25 }))).toMatchObject({ videoFadeInFrames: 25, videoFadeOutFrames: 5 })
    const [l, r] = splitClip(clip({ videoFadeInFrames: 10, videoFadeOutFrames: 12 }), 150, 'r', false)!
    expect([l.videoFadeInFrames, l.videoFadeOutFrames, r.videoFadeInFrames, r.videoFadeOutFrames]).toEqual([10, 0, 0, 12])
    const [scaled] = rescaleClips([clip({ videoFadeInFrames: 15 })], [asset('a', 'video', 60_000)], 30, 60)
    expect(scaled.videoFadeInFrames).toBe(30)
  })
  it('opens a v4 project unchanged with no picture fades', () => {
    const p = createEmptyProject('Old')
    const old = { ...p, schemaVersion: 4, clips: [{ id: 'x', trackId: p.tracks[2].id, assetId: 'm', startFrame: 0, sourceInFrame: 0, durationFrames: 30, volume: 100, fadeInFrames: 0, fadeOutFrames: 0 }], media: [asset('m', 'video')] }
    const m = migrateProject(old)
    expect(m.schemaVersion).toBe(6)
    expect(m.clips[0]).toMatchObject({ videoFadeInFrames: 0, videoFadeOutFrames: 0 })
  })
  it('puts alpha fades in the export graph, measured from the clip start, before the shift to timeline time', () => {
    const p = createEmptyProject('P')
    p.settings = { width: 640, height: 360, fps: 30 }
    p.media = [asset('a', 'video')]
    p.clips = [clip({ trackId: p.tracks.find((t) => t.name === 'Video 1')!.id, startFrame: 30, durationFrames: 90, videoFadeInFrames: 15, videoFadeOutFrames: 30 })]
    const { filter } = buildRenderPlan(p, { width: 640, height: 360, resolvePath: () => '/x', subtitleLists: {} })
    expect(filter).toContain('setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.500000:alpha=1,fade=t=out:st=2.000000:d=1.000000:alpha=1,setpts=PTS+1.000000/TB')
  })
})

const s = () => useProjectStore.getState()
const p = () => s().project!
beforeEach(() => {
  const proj = createEmptyProject('T')
  proj.media = [asset('v', 'video'), asset('a', 'audio')]
  s().load(proj, '/tmp/t')
  useUiStore.getState().patch({ playhead: 0, selectedClipId: null })
})
const track = (name: string) => p().tracks.find((t) => t.name === name)!.id

describe('transition actions', () => {
  it('sets picture fades with limits and merges a drag into one undo step', () => {
    const id = timeline.addAsset('v', track('Video 1'), 0)! // 300 frames
    for (const f of [5, 10, 20, 30]) timeline.setVideoFade(id, 'in', f)
    expect(p().clips[0].videoFadeInFrames).toBe(30)
    s().undo()
    expect(p().clips[0].videoFadeInFrames).toBe(0)
    timeline.setVideoFade(id, 'in', 250)
    timeline.setVideoFade(id, 'out', 250)
    expect([p().clips[0].videoFadeInFrames, p().clips[0].videoFadeOutFrames]).toEqual([250, 50])
    expect(validateClips(p())).toEqual([])
  })
  it('refuses picture fades on audio clips', () => {
    const id = timeline.addAsset('a', track('Audio 1'), 0)!
    expect(timeline.setVideoFade(id, 'in', 10)).toBe(false)
  })
  it('dips to black across a cut as one undo step, and only for clips on the same track in order', () => {
    const a = timeline.addAsset('v', track('Video 1'), 0)!
    const b = timeline.addAsset('v', track('Video 1'), 300)!
    expect(timeline.dipToBlack(b, a, 15)).toBe(false) // wrong order
    expect(timeline.dipToBlack(a, b, 15)).toBe(true)
    expect([p().clips.find((c) => c.id === a)!.videoFadeOutFrames, p().clips.find((c) => c.id === b)!.videoFadeInFrames]).toEqual([15, 15])
    s().undo()
    expect([p().clips.find((c) => c.id === a)!.videoFadeOutFrames, p().clips.find((c) => c.id === b)!.videoFadeInFrames]).toEqual([0, 0])
  })
})
