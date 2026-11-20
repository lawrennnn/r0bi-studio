import { beforeEach, describe, expect, it } from 'vitest'
import { compactEffects, EFFECT_PRESETS, effectsAt, effectsOf, hasEffects, splitEffects } from '../shared/effects'
import { ClipEffectsSchema, createEmptyProject, DEFAULT_EFFECTS, migrateProject, ProjectSchema, type Clip, type MediaAsset } from '../shared/project'
import { buildRenderPlan } from '../shared/render'
import { splitClip, validateClips } from '../shared/timeline'
import { useProjectStore } from '../src/store/projectStore'
import { useUiStore } from '../src/store/uiStore'
import { timeline } from '../src/store/timelineActions'

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'c', trackId: 't', assetId: 'a', startFrame: 100, sourceInFrame: 0, durationFrames: 101, volume: 100, fadeInFrames: 0, fadeOutFrames: 0, videoFadeInFrames: 0, videoFadeOutFrames: 0, ...over
})
const asset = (id: string, kind: MediaAsset['kind'], ms = 20_000): MediaAsset => ({
  id, kind, name: `${id}.x`, path: `/${id}.x`, pathKind: 'absolute', sizeBytes: 1, durationMs: kind === 'image' ? 0 : ms, width: 640, height: 360, fpsNum: 30, fpsDen: 1,
  videoCodec: kind === 'audio' ? null : 'h264', audioCodec: kind === 'image' ? null : 'aac', sampleRate: 48000, channels: 2, thumbnail: null, proxy: null, importedAt: ''
})

describe('effect maths', () => {
  it('has no effects by default and compacts back to nothing', () => {
    expect(hasEffects(clip())).toBe(false)
    expect(effectsOf(clip())).toEqual(DEFAULT_EFFECTS)
    expect(compactEffects(DEFAULT_EFFECTS)).toBeUndefined()
    expect(hasEffects(clip({ effects: { ...DEFAULT_EFFECTS, opacity: 80 } }))).toBe(true)
  })
  it('animates zoom and position in a straight line from first to last frame', () => {
    const c = clip({ effects: { ...DEFAULT_EFFECTS, scaleStart: 100, scaleEnd: 200, posStartX: -10, posEndX: 10, opacity: 50 } })
    expect(effectsAt(c, 100)).toEqual({ opacity: 0.5, scale: 1, x: -10, y: 0 })
    expect(effectsAt(c, 150)).toEqual({ opacity: 0.5, scale: 1.5, x: 0, y: 0 })
    expect(effectsAt(c, 200)).toEqual({ opacity: 0.5, scale: 2, x: 10, y: 0 })
    expect(effectsAt(c, 999).scale).toBe(2) // clamped after the clip
    expect(effectsAt(c, 0).scale).toBe(1) // and before it
  })
  it('validates ranges: zoom 100-400, position within the frame, opacity 0-100', () => {
    expect(ClipEffectsSchema.safeParse({}).data).toEqual(DEFAULT_EFFECTS)
    expect(ClipEffectsSchema.safeParse({ scaleStart: 50 }).success).toBe(false)
    expect(ClipEffectsSchema.safeParse({ scaleEnd: 401 }).success).toBe(false)
    expect(ClipEffectsSchema.safeParse({ posEndX: 150 }).success).toBe(false)
    expect(ClipEffectsSchema.safeParse({ opacity: 101 }).success).toBe(false)
    for (const p of EFFECT_PRESETS) expect(ClipEffectsSchema.safeParse({ ...DEFAULT_EFFECTS, ...p.effects }).success).toBe(true)
  })
  it('continues an animation smoothly across a split', () => {
    const effects = { ...DEFAULT_EFFECTS, scaleStart: 100, scaleEnd: 200, posStartX: 0, posEndX: 40 }
    const [l, r] = splitClip(clip({ effects }), 150, 'r', false)!
    // The left half ends where the whole clip was one frame before the cut, and the right half starts at the cut frame.
    expect(l.effects).toMatchObject({ scaleStart: 100, scaleEnd: 149, posEndX: 20 })
    expect(r.effects).toMatchObject({ scaleStart: 150, scaleEnd: 200, posStartX: 20, posEndX: 40 })
    const whole = (f: number) => effectsAt(clip({ effects }), f).scale
    expect(effectsAt(l, 149).scale).toBeCloseTo(whole(149), 1)
    expect(effectsAt(r, 150).scale).toBeCloseTo(whole(150), 1)
    expect(splitEffects(DEFAULT_EFFECTS, 100, 50)).toEqual([undefined, undefined])
    const plain = splitClip(clip(), 150, 'r', false)!
    expect('effects' in plain[0]).toBe(false)
    expect('effects' in plain[1]).toBe(false)
  })
  it('opens an older project and keeps effects through save and load', () => {
    const p = createEmptyProject('P')
    const withFx = { ...p, schemaVersion: 6, media: [asset('a', 'video')], clips: [clip({ trackId: p.tracks[2].id, effects: { ...DEFAULT_EFFECTS, scaleEnd: 130 } })] }
    expect(migrateProject(JSON.parse(JSON.stringify(withFx))).clips[0].effects?.scaleEnd).toBe(130)
    const old = { ...p, schemaVersion: 5, media: [asset('a', 'video')], clips: [clip({ trackId: p.tracks[2].id })] }
    const m = migrateProject(old)
    expect(m.schemaVersion).toBe(6)
    expect(m.clips[0].effects).toBeUndefined()
    expect(ProjectSchema.safeParse(m).success).toBe(true)
  })
})

describe('effects in the export graph', () => {
  const plan = (c: Partial<Clip>) => {
    const p = createEmptyProject('P')
    p.settings = { width: 640, height: 360, fps: 30 }
    p.media = [asset('a', 'video')]
    p.clips = [clip({ trackId: p.tracks.find((t) => t.name === 'Video 1')!.id, startFrame: 30, durationFrames: 91, ...c })]
    return buildRenderPlan(p, { width: 640, height: 360, resolvePath: () => '/x', subtitleLists: {} }).filter
  }
  it('adds nothing for a clip without effects', () => {
    const f = plan({})
    expect(f).not.toContain('zoompan')
    expect(f).not.toContain('colorchannelmixer')
    expect(f).not.toMatch(/overlay=x=/)
  })
  it('zooms about the centre with a smooth pre-scale, animating by output frame', () => {
    const f = plan({ effects: { ...DEFAULT_EFFECTS, scaleStart: 100, scaleEnd: 130 } })
    expect(f).toContain("scale=1280:720:flags=bicubic,zoompan=z='1.0000+0.3000*on/90':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=640x360:fps=30")
    expect(f.indexOf('setpts=PTS-STARTPTS')).toBeLessThan(f.indexOf('zoompan')) // clip-local time, before the shift to the timeline
    expect(f.indexOf('zoompan')).toBeLessThan(f.indexOf('setpts=PTS+1.000000/TB'))
  })
  it('applies opacity as an alpha multiply and position as an overlay offset (animated or fixed)', () => {
    expect(plan({ effects: { ...DEFAULT_EFFECTS, opacity: 40 } })).toContain('colorchannelmixer=aa=0.4000')
    expect(plan({ effects: { ...DEFAULT_EFFECTS, posStartX: 10, posEndX: 10 } })).toContain("overlay=x='(main_w-overlay_w)/2+10*main_w/100':y='(main_h-overlay_h)/2+0*main_h/100':")
    const anim = plan({ effects: { ...DEFAULT_EFFECTS, posStartX: -10, posEndX: 10 } })
    expect(anim).toContain('(-10+(20)*clip((t-1.000000)/3.000000,0,1))*main_w/100')
  })
})

const s = () => useProjectStore.getState()
const p = () => s().project!
const track = (name: string) => p().tracks.find((t) => t.name === name)!.id

beforeEach(() => {
  const proj = createEmptyProject('T')
  proj.media = [asset('v', 'video', 20_000), asset('i', 'image'), asset('a', 'audio')]
  s().load(proj, '/tmp/t')
  useUiStore.getState().patch({ playhead: 0, selectedClipId: null })
})

describe('effect actions', () => {
  it('sets effects on picture clips, merges a slider drag into one undo step, and removes them when back to default', () => {
    const id = timeline.addAsset('v', track('Video 1'), 0)!
    for (const v of [90, 70, 50]) timeline.setEffects(id, { opacity: v })
    expect(p().clips[0].effects).toEqual({ ...DEFAULT_EFFECTS, opacity: 50 })
    s().undo()
    expect(p().clips[0].effects).toBeUndefined()
    timeline.setEffects(id, { scaleEnd: 130 })
    timeline.resetEffects(id)
    expect('effects' in p().clips[0]).toBe(false)
  })
  it('applies presets (keeping opacity), refuses audio and locked tracks, and rejects out-of-range values', () => {
    const id = timeline.addAsset('i', track('Video 1'), 0)!
    timeline.setEffects(id, { opacity: 60 })
    expect(timeline.applyEffectPreset(id, 'pan-left')).toBe(true)
    expect(p().clips[0].effects).toMatchObject({ opacity: 60, scaleStart: 112, posStartX: 5, posEndX: -5 })
    expect(timeline.setEffects(id, { scaleStart: 10 })).toBe(false)
    expect(timeline.applyEffectPreset(id, 'nope')).toBe(false)
    const audio = timeline.addAsset('a', track('Audio 1'), 0)!
    expect(timeline.setEffects(audio, { opacity: 10 })).toBe(false)
    s().commit((d) => void (d.tracks.find((t) => t.name === 'Video 1')!.locked = true))
    expect(timeline.setEffects(id, { opacity: 10 })).toBe(false)
  })
  it('dissolves into the next clip using its lead-in footage, on a new track above, as one undo step', () => {
    const a = timeline.addAsset('v', track('Video 1'), 0)! // 600 frames (20 s)
    s().commit((d) => void (d.clips.find((c) => c.id === a)!.durationFrames = 300))
    const b = timeline.addAsset('v', track('Video 1'), 300)!
    s().commit((d) => {
      const c = d.clips.find((x) => x.id === b)!
      c.sourceInFrame = 120
      c.durationFrames = 200
    })
    const depth = s().past.length
    expect(timeline.dissolveIntoNext(a, 30)).toEqual({ ok: true })
    expect(s().past.length).toBe(depth + 1)
    const moved = p().clips.find((c) => c.id === b)!
    expect(moved).toMatchObject({ startFrame: 270, sourceInFrame: 90, durationFrames: 230, videoFadeInFrames: 30, fadeInFrames: 30 })
    expect(moved.trackId).not.toBe(track('Video 1'))
    const upper = p().tracks.find((t) => t.id === moved.trackId)!
    expect(upper.kind).toBe('video')
    expect(p().tracks.findIndex((t) => t.id === upper.id)).toBeLessThan(p().tracks.findIndex((t) => t.id === track('Video 1'))) // above
    expect(p().clips.find((c) => c.id === a)!.fadeOutFrames).toBe(30)
    expect(validateClips(p())).toEqual([])
    s().undo()
    expect(p().clips.find((c) => c.id === b)).toMatchObject({ startFrame: 300, sourceInFrame: 120, durationFrames: 200 })
    expect(p().tracks.some((t) => t.id === upper.id)).toBe(false)
  })
  it('explains why a dissolve is not possible', () => {
    const a = timeline.addAsset('v', track('Video 1'), 0)!
    s().commit((d) => void (d.clips.find((c) => c.id === a)!.durationFrames = 300))
    expect(timeline.dissolveIntoNext(a, 30)).toMatchObject({ ok: false, error: expect.stringMatching(/no clip directly after/) })
    const b = timeline.addAsset('v', track('Video 1'), 300)! // starts at the source's beginning: no lead-in
    expect(b).toBeTruthy()
    expect(timeline.dissolveIntoNext(a, 30)).toMatchObject({ ok: false, error: expect.stringMatching(/not enough/) })
    const img = timeline.addAsset('i', track('Video 2'), 0)!
    expect(timeline.dissolveIntoNext(img, 30)).toMatchObject({ ok: false })
    expect(timeline.dissolveIntoNext('missing', 30)).toMatchObject({ ok: false })
  })
  it('dissolves into a still image (stills have no lead-in limit) and reuses a free track above', () => {
    const a = timeline.addAsset('v', track('Video 2'), 0)!
    s().commit((d) => void (d.clips.find((c) => c.id === a)!.durationFrames = 300))
    const b = timeline.addAsset('i', track('Video 2'), 300)!
    expect(timeline.dissolveIntoNext(a, 45)).toEqual({ ok: true })
    const moved = p().clips.find((c) => c.id === b)!
    expect(moved).toMatchObject({ startFrame: 255, sourceInFrame: 0, durationFrames: 195 })
    expect(moved.trackId).toBe(track('Video 1')) // the existing free track above Video 2
    expect(p().tracks).toHaveLength(6)
  })
})
