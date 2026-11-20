import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyProject, type Clip, type MediaAsset } from '../shared/project'
import { clipEnd, closeGapsOnTrack, clipsOnTrack, reorderOnTrack, rippleDeleteOnTrack, validateClips } from '../shared/timeline'
import { useProjectStore } from '../src/store/projectStore'
import { useUiStore } from '../src/store/uiStore'
import { timeline } from '../src/store/timelineActions'

const clip = (id: string, start: number, dur: number, trackId = 't'): Clip => ({
  id, trackId, assetId: 'a', startFrame: start, sourceInFrame: 0, durationFrames: dur, volume: 100, fadeInFrames: 0, fadeOutFrames: 0, videoFadeInFrames: 0, videoFadeOutFrames: 0
})
const starts = (clips: Clip[], trackId = 't') => clipsOnTrack(clips, trackId).map((c) => `${c.id}@${c.startFrame}`)

describe('scene ordering helpers', () => {
  // A 0..100, gap 20, B 120..150, gap 10, C 160..220
  const base = [clip('A', 0, 100), clip('B', 120, 30), clip('C', 160, 60), clip('other', 0, 500, 'x')]
  it('reorders scenes in place, keeping the first start, each slot gap and the total span', () => {
    const r = reorderOnTrack(base, 't', 0, 2)! // A moves to the end: B, C, A
    expect(starts(r)).toEqual(['B@0', 'C@50', 'A@120'])
    const span = (cs: Clip[]) => [Math.min(...cs.map((c) => c.startFrame)), Math.max(...cs.map(clipEnd))]
    expect(span(clipsOnTrack(r, 't'))).toEqual(span(clipsOnTrack(base, 't')))
    expect(r.find((c) => c.id === 'other')).toEqual(base[3]) // other tracks untouched
    expect(starts(reorderOnTrack(base, 't', 2, 0)!)).toEqual(['C@0', 'A@80', 'B@190'])
    expect(starts(reorderOnTrack(base, 't', 1, 0)!)).toEqual(['B@0', 'A@50', 'C@160'])
  })
  it('refuses a no-op or out-of-range move', () => {
    expect(reorderOnTrack(base, 't', 1, 1)).toBeNull()
    expect(reorderOnTrack(base, 't', -1, 1)).toBeNull()
    expect(reorderOnTrack(base, 't', 0, 3)).toBeNull()
    expect(reorderOnTrack(base, 'empty', 0, 1)).toBeNull()
  })
  it('packs scenes back to back and ripple-deletes', () => {
    expect(starts(closeGapsOnTrack(base, 't'))).toEqual(['A@0', 'B@100', 'C@130'])
    expect(starts(rippleDeleteOnTrack(base, 'B'))).toEqual(['A@0', 'C@130'])
    expect(starts(rippleDeleteOnTrack(base, 'C'))).toEqual(['A@0', 'B@120'])
    expect(rippleDeleteOnTrack(base, 'nope')).toEqual(base)
    expect(closeGapsOnTrack([], 't')).toEqual([])
  })
  it('any permutation keeps scenes inside the same span without overlapping', () => {
    let seed = 3
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n)
    for (let round = 0; round < 300; round++) {
      let cs: Clip[] = []
      let t = rnd(50)
      for (let i = 0; i < 2 + rnd(6); i++) {
        const d = 1 + rnd(120)
        cs.push(clip(`c${i}`, t, d))
        t += d + rnd(40)
      }
      const before = clipsOnTrack(cs, 't')
      const lo = before[0].startFrame
      const hi = clipEnd(before[before.length - 1])
      for (let step = 0; step < 5; step++) cs = reorderOnTrack(cs, 't', rnd(cs.length), rnd(cs.length)) ?? cs
      const after = clipsOnTrack(cs, 't')
      expect(after[0].startFrame).toBe(lo)
      expect(clipEnd(after[after.length - 1])).toBe(hi)
      for (let i = 1; i < after.length; i++) expect(after[i].startFrame).toBeGreaterThanOrEqual(clipEnd(after[i - 1]))
      expect(after.map((c) => c.id).sort()).toEqual(before.map((c) => c.id).sort())
    }
  })
})

const asset = (id: string, ms = 20_000): MediaAsset => ({
  id, kind: 'video', name: `${id}.mp4`, path: `/${id}`, pathKind: 'absolute', sizeBytes: 1, durationMs: ms, width: 640, height: 360, fpsNum: 30, fpsDen: 1,
  videoCodec: 'h264', audioCodec: 'aac', sampleRate: 48000, channels: 2, thumbnail: null, proxy: null, importedAt: ''
})
const s = () => useProjectStore.getState()
const p = () => s().project!
const v1 = () => p().tracks.find((t) => t.name === 'Video 1')!.id

beforeEach(() => {
  const proj = createEmptyProject('T')
  proj.media = [asset('a', 6_000), asset('b', 3_000), asset('c', 4_000)]
  s().load(proj, '/tmp/t')
  useUiStore.getState().patch({ playhead: 0, selectedClipId: null })
})

describe('scene manager actions', () => {
  const three = () => ['a', 'b', 'c'].map((id) => timeline.addAsset(id, v1(), 0)!) // 180, 90, 120 frames back to back
  it('reorders as one undo step and keeps the timeline valid', () => {
    const [a, b, c] = three()
    const depth = s().past.length
    expect(timeline.reorderScene(v1(), 2, 0)).toBe(true)
    expect(s().past.length).toBe(depth + 1)
    const order = clipsOnTrack(p().clips, v1()).map((x) => x.id)
    expect(order).toEqual([c, a, b])
    expect(clipsOnTrack(p().clips, v1()).map((x) => x.startFrame)).toEqual([0, 120, 300])
    expect(validateClips(p())).toEqual([])
    s().undo()
    expect(clipsOnTrack(p().clips, v1()).map((x) => x.id)).toEqual([a, b, c])
    expect(timeline.reorderScene(v1(), 0, 9)).toBe(false)
    s().commit((d) => void (d.tracks.find((t) => t.id === v1())!.locked = true))
    expect(timeline.reorderScene(v1(), 0, 1)).toBe(false)
  })
  it('ripple-deletes and closes gaps, refusing when locked', () => {
    const [a, b, c] = three()
    expect(timeline.rippleDelete(b)).toBe(true)
    expect(clipsOnTrack(p().clips, v1()).map((x) => [x.id, x.startFrame])).toEqual([[a, 0], [c, 180]])
    s().undo()
    timeline.remove(b) // plain delete leaves a gap
    expect(timeline.closeGaps(v1())).toBe(true)
    expect(clipsOnTrack(p().clips, v1()).map((x) => x.startFrame)).toEqual([0, 180])
    expect(timeline.closeGaps(v1())).toBe(false) // nothing left to close
    s().commit((d) => void (d.tracks.find((t) => t.id === v1())!.locked = true))
    expect(timeline.rippleDelete(a)).toBe(false)
  })
  it('keeps notes on a clip, merges typing into one undo step, removes empty ones, and copies them on split and duplicate', () => {
    const [a] = three()
    for (const t of ['L', 'Li', 'Lis', 'List']) timeline.setNote(a, t)
    expect(p().clips.find((c) => c.id === a)!.note).toBe('List')
    s().undo()
    expect(p().clips.find((c) => c.id === a)!.note).toBeUndefined()
    timeline.setNote(a, 'Opening shot')
    useUiStore.getState().patch({ playhead: 60, selectedClipId: a })
    timeline.split()
    expect(p().clips.filter((c) => c.note === 'Opening shot')).toHaveLength(2)
    timeline.setNote(a, '')
    expect('note' in p().clips.find((c) => c.id === a)!).toBe(false)
    expect(timeline.setNote(a, 'x'.repeat(501))).toBe(false)
  })
})
