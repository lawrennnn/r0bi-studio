import { describe, expect, it } from 'vitest'
import type { Clip, MediaAsset } from '../shared/project'
import { createEmptyProject, migrateProject } from '../shared/project'
import {
  assetFrames, canPlace, clampClipsToAsset, clipEnd, defaultClipFrames, findFreeStart, rescaleClips,
  snapEdge, snapPoints, snapStart, splitClip, trimLeft, trimRight, validateClips
} from '../shared/timeline'

const asset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'a1', kind: 'video', name: 'a.mp4', path: '/a.mp4', pathKind: 'absolute', sizeBytes: 1, durationMs: 10_000,
  width: 1920, height: 1080, fpsNum: 30, fpsDen: 1, videoCodec: 'h264', audioCodec: 'aac', sampleRate: 48000, channels: 2,
  thumbnail: null, proxy: null, importedAt: '', ...over
})
const clip = (id: string, start: number, dur: number, over: Partial<Clip> = {}): Clip => ({
  id, trackId: 't1', assetId: 'a1', startFrame: start, sourceInFrame: 0, durationFrames: dur, volume: 100, fadeInFrames: 0, fadeOutFrames: 0, videoFadeInFrames: 0, videoFadeOutFrames: 0, ...over
})

describe('placement rules', () => {
  it('matches asset kinds to track kinds', () => {
    expect(canPlace('video', 'video')).toBe(true)
    expect(canPlace('video', 'image')).toBe(true)
    expect(canPlace('overlay', 'image')).toBe(true)
    expect(canPlace('audio', 'audio')).toBe(true)
    expect(canPlace('audio', 'video')).toBe(false)
    expect(canPlace('video', 'audio')).toBe(false)
    expect(canPlace('subtitle', 'video')).toBe(false)
  })
  it('computes source frames and defaults', () => {
    expect(assetFrames(asset({ durationMs: 1999 }), 30)).toBe(59)
    expect(assetFrames(asset({ kind: 'image', durationMs: 0 }), 30)).toBeNull()
    expect(defaultClipFrames(asset({ kind: 'image', durationMs: 0 }), 24)).toBe(120)
  })
})

describe('findFreeStart', () => {
  const clips = [clip('a', 30, 30), clip('b', 90, 30)] // occupied 30-60 and 90-120
  it('keeps a free desired position', () => expect(findFreeStart(clips, 't1', 20, 65)).toBe(65))
  it('moves to the nearest free slot when blocked', () => {
    expect(findFreeStart(clips, 't1', 20, 40)).toBe(60) // 40 overlaps a; nearest free is right after a
    expect(findFreeStart(clips, 't1', 20, 35)).toBe(10) // exact tie: prefers the earlier slot
    expect(findFreeStart(clips, 't1', 20, 28)).toBe(10) // ends exactly at a's start
  })
  it('falls to the end when no gap is large enough', () => {
    expect(findFreeStart(clips, 't1', 40, 50)).toBe(120)
  })
  it('never returns a negative start', () => expect(findFreeStart(clips, 't1', 20, -50)).toBe(0))
  it('ignores the clip being moved and other tracks', () => {
    expect(findFreeStart(clips, 't1', 30, 30, 'a')).toBe(30)
    expect(findFreeStart(clips, 't2', 30, 30)).toBe(30)
  })
})

describe('snapping', () => {
  const pts = snapPoints([clip('a', 100, 50), clip('b', 300, 10)], 'b', 200)
  it('collects clip edges (excluding the dragged clip), playhead and zero', () => {
    expect(pts.sort((x, y) => x - y)).toEqual([0, 100, 150, 200])
  })
  it('snaps start or end within the threshold', () => {
    expect(snapStart(97, 40, pts, 5)).toEqual({ start: 100, snapped: 100 })
    expect(snapStart(158, 40, pts, 5)).toEqual({ start: 160, snapped: 200 }) // end 198 -> 200
    expect(snapStart(120, 10, pts, 5)).toEqual({ start: 120, snapped: null })
  })
  it('snaps a single edge', () => {
    expect(snapEdge(148, pts, 3)).toEqual({ frame: 150, snapped: 150 })
    expect(snapEdge(170, pts, 3)).toEqual({ frame: 170, snapped: null })
  })
})

describe('trimming', () => {
  const a = asset()
  it('trims the left edge, advancing the source in-point', () => {
    const c = clip('c', 100, 60, { sourceInFrame: 20 })
    expect(trimLeft(c, 110, [c], a)).toMatchObject({ startFrame: 110, sourceInFrame: 30, durationFrames: 50 })
  })
  it('cannot extend left past the start of the source', () => {
    const c = clip('c', 100, 60, { sourceInFrame: 20 })
    expect(trimLeft(c, 0, [c], a)).toMatchObject({ startFrame: 80, sourceInFrame: 0, durationFrames: 80 })
  })
  it('cannot extend left into the previous clip', () => {
    const prev = clip('p', 0, 95)
    const c = clip('c', 100, 60, { sourceInFrame: 50 })
    expect(trimLeft(c, 50, [prev, c], a).startFrame).toBe(95)
  })
  it('keeps at least one frame', () => {
    const c = clip('c', 100, 60)
    expect(trimLeft(c, 500, [c], a)).toMatchObject({ startFrame: 159, durationFrames: 1 })
    expect(trimRight(c, 0, [c], a, 30).durationFrames).toBe(1)
  })
  it('limits right trim to the source end and the next clip', () => {
    const c = clip('c', 0, 100, { sourceInFrame: 100 }) // source is 300 frames at 30fps
    expect(trimRight(c, 999, [c], a, 30).durationFrames).toBe(200)
    const next = clip('n', 150, 10)
    expect(trimRight(c, 999, [c, next], a, 30).durationFrames).toBe(150)
  })
  it('treats still images as unlimited and keeps the source in-point at zero', () => {
    const img = asset({ kind: 'image', durationMs: 0 })
    const c = clip('c', 100, 150)
    expect(trimRight(c, 10_000, [c], img, 30).durationFrames).toBe(9900)
    expect(trimLeft(c, 120, [c], img)).toMatchObject({ startFrame: 120, sourceInFrame: 0, durationFrames: 130 })
  })
})

describe('splitting', () => {
  it('splits a clip in two without losing or repeating frames', () => {
    const c = clip('c', 100, 60, { sourceInFrame: 10 })
    const [l, r] = splitClip(c, 130, 'r', false)!
    expect(l).toMatchObject({ startFrame: 100, sourceInFrame: 10, durationFrames: 30 })
    expect(r).toMatchObject({ id: 'r', startFrame: 130, sourceInFrame: 40, durationFrames: 30 })
    expect(clipEnd(l)).toBe(r.startFrame)
  })
  it('refuses to split at or outside the edges', () => {
    const c = clip('c', 100, 60)
    expect(splitClip(c, 100, 'r', false)).toBeNull()
    expect(splitClip(c, 160, 'r', false)).toBeNull()
    expect(splitClip(c, 50, 'r', false)).toBeNull()
  })
})

describe('frame-rate changes', () => {
  it('rescales and keeps adjacent clips adjacent', () => {
    const media = [asset({ durationMs: 60_000 })]
    const out = rescaleClips([clip('a', 0, 25), clip('b', 25, 25, { sourceInFrame: 7 })], media, 25, 30)
    expect(out[0]).toMatchObject({ startFrame: 0, durationFrames: 30 })
    expect(out[1]).toMatchObject({ startFrame: 30, durationFrames: 30, sourceInFrame: 8 })
    expect(validateClips({ clips: out, tracks: [{ id: 't1', kind: 'video', name: 'V', muted: false, locked: false, visible: true, volume: 100 }], media, settings: { width: 1, height: 1, fps: 30 } })).toEqual([])
  })
  it('clamps clips to the source after relink or rate change', () => {
    const out = clampClipsToAsset([clip('a', 0, 500, { sourceInFrame: 100 })], asset({ durationMs: 10_000 }), 30)
    expect(out[0]).toMatchObject({ sourceInFrame: 100, durationFrames: 200 })
  })
})

describe('project migration and repair', () => {
  it('upgrades a v2 project with an empty clip list', () => {
    const { clips: _c, subtitles: _s, ...v2 } = createEmptyProject('Old')
    void _c
    void _s
    const m = migrateProject({ ...v2, schemaVersion: 2 })
    expect(m.schemaVersion).toBe(6)
    expect(m.clips).toEqual([])
  })
  it('drops clips whose track or media is gone so the project still opens', () => {
    const p = createEmptyProject('X')
    const m = migrateProject({ ...p, clips: [clip('orphan', 0, 10, { trackId: p.tracks[0].id, assetId: 'nope' })] })
    expect(m.clips).toEqual([])
  })
})
