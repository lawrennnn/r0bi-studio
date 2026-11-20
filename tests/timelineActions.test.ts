import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyProject, type MediaAsset } from '../shared/project'
import { validateClips } from '../shared/timeline'
import { useProjectStore } from '../src/store/projectStore'
import { useUiStore } from '../src/store/uiStore'
import { timeline } from '../src/store/timelineActions'

const asset = (id: string, kind: MediaAsset['kind'], durationMs: number): MediaAsset => ({
  id, kind, name: `${id}.x`, path: `/${id}.x`, pathKind: 'absolute', sizeBytes: 1, durationMs,
  width: 1920, height: 1080, fpsNum: 30, fpsDen: 1, videoCodec: kind === 'audio' ? null : 'h264',
  audioCodec: kind === 'image' ? null : 'aac', sampleRate: 48000, channels: 2, thumbnail: null, proxy: null, importedAt: ''
})
const s = () => useProjectStore.getState()
const p = () => s().project!
const track = (name: string) => p().tracks.find((t) => t.name === name)!.id

beforeEach(() => {
  const proj = createEmptyProject('T')
  proj.media = [asset('v', 'video', 10_000), asset('a', 'audio', 5_000), asset('i', 'image', 0)]
  s().load(proj, '/tmp/t')
  useUiStore.getState().patch({ playhead: 0, selectedClipId: null })
})

describe('timeline actions', () => {
  it('adds assets only to compatible, unlocked tracks', () => {
    expect(timeline.addAsset('v', track('Audio 1'), 0)).toBeNull()
    expect(timeline.addAsset('a', track('Video 1'), 0)).toBeNull()
    expect(timeline.addAsset('v', track('Video 1'), 0)).toBeTruthy()
    s().commit((d) => void (d.tracks.find((t) => t.name === 'Video 2')!.locked = true))
    expect(timeline.addAsset('v', track('Video 2'), 0)).toBeNull()
    expect(p().clips).toHaveLength(1)
    expect(p().clips[0].durationFrames).toBe(300)
  })

  it('uses 5 seconds for stills and picks the first fitting track automatically', () => {
    useUiStore.getState().patch({ playhead: 45 })
    const id = timeline.addAssetAuto('i')!
    const c = p().clips.find((x) => x.id === id)!
    expect([c.durationFrames, c.startFrame]).toEqual([150, 45])
    expect(p().tracks.find((t) => t.id === c.trackId)!.kind).toBe('overlay') // first track that accepts images
    expect(timeline.addAssetAuto('a')).toBeTruthy()
  })

  it('pushes a new clip to free space instead of overlapping', () => {
    timeline.addAsset('v', track('Video 1'), 0)
    timeline.addAsset('v', track('Video 1'), 10)
    const starts = p().clips.map((c) => c.startFrame).sort((x, y) => x - y)
    expect(starts).toEqual([0, 300])
    expect(validateClips(p())).toEqual([])
  })

  it('splits at the playhead and undoes in one step', () => {
    const id = timeline.addAsset('v', track('Video 1'), 0)!
    useUiStore.getState().patch({ playhead: 100 })
    expect(timeline.split()).toBe(1)
    expect(p().clips).toHaveLength(2)
    const [l, r] = p().clips
    expect([l.durationFrames, r.startFrame, r.sourceInFrame, r.durationFrames]).toEqual([100, 100, 100, 200])
    expect(l.id).toBe(id)
    s().undo()
    expect(p().clips).toHaveLength(1)
    expect(p().clips[0].durationFrames).toBe(300)
  })

  it('does not split locked tracks or at clip edges', () => {
    timeline.addAsset('v', track('Video 1'), 0)
    useUiStore.getState().patch({ playhead: 0, selectedClipId: null })
    expect(timeline.split()).toBe(0)
    useUiStore.getState().patch({ playhead: 50 })
    s().commit((d) => void (d.tracks.find((t) => t.name === 'Video 1')!.locked = true))
    expect(timeline.split()).toBe(0)
  })

  it('duplicates after the original, deletes, and respects locks', () => {
    const id = timeline.addAsset('a', track('Audio 1'), 0)!
    const copy = timeline.duplicate(id)!
    expect(p().clips.find((c) => c.id === copy)!.startFrame).toBe(150)
    expect(timeline.remove(copy)).toBe(true)
    s().commit((d) => void (d.tracks.find((t) => t.name === 'Audio 1')!.locked = true))
    expect(timeline.remove(id)).toBe(false)
    expect(timeline.duplicate(id)).toBeNull()
  })

  it('properties edits are validated', () => {
    const id = timeline.addAsset('v', track('Video 1'), 0)!
    expect(timeline.setDuration(id, 90)).toBe(true)
    expect(p().clips[0].durationFrames).toBe(90)
    expect(timeline.setDuration(id, 9999)).toBe(true) // clamped to the source
    expect(p().clips[0].durationFrames).toBe(300)
    expect(timeline.setSourceIn(id, 50)).toBe(true)
    expect(p().clips[0].sourceInFrame).toBe(0) // can't move the in-point if it would run past the end
    timeline.setDuration(id, 100)
    expect(timeline.setSourceIn(id, 50)).toBe(true)
    expect(p().clips[0].sourceInFrame).toBe(50)
    expect(validateClips(p())).toEqual([])
  })

  it('rescales clips when the frame rate changes', () => {
    timeline.addAsset('v', track('Video 1'), 30)
    useUiStore.getState().patch({ playhead: 60 })
    timeline.setFps(60)
    expect(p().settings.fps).toBe(60)
    expect([p().clips[0].startFrame, p().clips[0].durationFrames]).toEqual([60, 600])
    expect(useUiStore.getState().playhead).toBe(120)
    expect(validateClips(p())).toEqual([])
  })

  it('survives a long random sequence of edits without breaking any rule', () => {
    let seed = 12345
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n)
    const kinds = ['Video 1', 'Video 2', 'Audio 1', 'Audio 2', 'Overlay 1']
    for (let step = 0; step < 600; step++) {
      const clips = p().clips
      const pick = clips.length ? clips[rnd(clips.length)] : null
      useUiStore.getState().patch({ playhead: rnd(900), selectedClipId: rnd(3) === 0 ? null : (pick?.id ?? null) })
      switch (rnd(8)) {
        case 0: case 1: timeline.addAsset(['v', 'a', 'i'][rnd(3)], track(kinds[rnd(kinds.length)]), rnd(900)); break
        case 2: timeline.split(); break
        case 3: if (pick) timeline.remove(pick.id); break
        case 4: if (pick) timeline.duplicate(pick.id); break
        case 5: if (pick) timeline.setStart(pick.id, rnd(900)); break
        case 6: if (pick) timeline.setDuration(pick.id, 1 + rnd(400)); break
        case 7: if (rnd(4) === 0) s().undo(); else if (rnd(4) === 0) s().redo(); else if (pick) timeline.setSourceIn(pick.id, rnd(300)); break
      }
      expect(validateClips(p()), `after step ${step}`).toEqual([])
    }
    expect(p().clips.length).toBeGreaterThan(0)
  })
})
