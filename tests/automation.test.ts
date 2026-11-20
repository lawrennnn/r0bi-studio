import { describe, expect, it } from 'vitest'
import {
  applyTemplate, assembleScenes, batchFileName, BUILTIN_PRESETS, captureScene, captureTemplate, DEFAULT_RECIPE, insertScene, PresetSchema, presetToSettings,
  refKey, SceneSchema, sceneMedia, TemplateSchema
} from '../shared/automation'
import { createEmptyProject, DEFAULT_SUBTITLE_STYLE, type Clip, type MediaAsset, type Project } from '../shared/project'
import { DEFAULT_EXPORT_SETTINGS } from '../shared/render'
import { validateClips, validateSubtitles } from '../shared/timeline'

const asset = (id: string, kind: MediaAsset['kind'], name: string, ms = 10_000): MediaAsset => ({
  id, kind, name, path: `C:\\Media\\${name}`, pathKind: 'absolute', sizeBytes: 1, durationMs: kind === 'image' ? 0 : ms, width: 1920, height: 1080, fpsNum: 30, fpsDen: 1,
  videoCodec: kind === 'audio' ? null : 'h264', audioCodec: kind === 'image' ? null : 'aac', sampleRate: 48000, channels: 2, thumbnail: null, proxy: null, importedAt: ''
})
const clip = (p: Project, id: string, track: string, a: string, start: number, dur: number, extra: Partial<Clip> = {}): Clip => {
  const c: Clip = { id, trackId: p.tracks.find((t) => t.name === track)!.id, assetId: a, startFrame: start, sourceInFrame: 0, durationFrames: dur, volume: 100, fadeInFrames: 0, fadeOutFrames: 0, videoFadeInFrames: 0, videoFadeOutFrames: 0, ...extra }
  p.clips.push(c)
  return c
}
function project(): Project {
  const p = createEmptyProject('Ep')
  p.settings = { width: 1920, height: 1080, fps: 30 }
  p.media = [asset('v1', 'video', 'a.mp4', 10_000), asset('v2', 'video', 'b.mp4', 6_000), asset('i1', 'image', 'x.png'), asset('i2', 'image', 'y.png'), asset('n', 'audio', 'voice.wav', 40_000), asset('m', 'audio', 'music.mp3', 90_000)]
  return p
}
const abs = (a: MediaAsset) => a.path
const lookup = (p: Project) => (ref: { path: string }) => p.media.find((a) => refKey(a.path) === refKey(ref.path)) ?? null

describe('templates', () => {
  it('captures structure, levels, subtitle style, export settings and recipe, and validates', () => {
    const p = project()
    p.tracks.find((t) => t.kind === 'subtitle')!.subtitleStyle = { ...DEFAULT_SUBTITLE_STYLE, fontSize: 64, color: '#ffcc00' }
    p.tracks.find((t) => t.name === 'Audio 2')!.volume = 30
    const t = captureTemplate(p, { id: 't1', name: ' Episode ', description: 'My look' }, { ...DEFAULT_EXPORT_SETTINGS, fileName: 'x', resolution: '720p' }, DEFAULT_RECIPE)
    expect(TemplateSchema.safeParse(t).success).toBe(true)
    expect(t.name).toBe('Episode')
    expect(t.exportSettings).toEqual({ resolution: '720p', quality: 'standard', encoder: 'auto' })
    expect(t.tracks.find((x) => x.name === 'Audio 2')!.volume).toBe(30)
    expect(t.tracks.find((x) => x.kind === 'subtitle')!.subtitleStyle).toMatchObject({ fontSize: 64, color: '#ffcc00' })
    expect(JSON.stringify(t)).not.toContain('clips')
  })
  it('applies to a project: adds missing tracks in order, styles matches, and leaves clips alone', () => {
    const src = project()
    src.tracks.push({ ...src.tracks[0], id: 'extra', kind: 'audio', name: 'Narration', volume: 80 })
    src.tracks.find((t) => t.kind === 'subtitle')!.subtitleStyle = { ...DEFAULT_SUBTITLE_STYLE, fontSize: 70 }
    src.settings = { width: 1280, height: 720, fps: 24 }
    const t = captureTemplate(src, { id: 't', name: 'T', description: '' }, DEFAULT_EXPORT_SETTINGS, DEFAULT_RECIPE)

    const target = project()
    clip(target, 'k', 'Video 1', 'v1', 0, 100)
    const r = applyTemplate(target, t)
    expect(r.tracks.map((x) => x.name)).toEqual([...target.tracks.map((x) => x.name), 'Narration'])
    expect(r.tracks.find((x) => x.kind === 'subtitle')!.subtitleStyle!.fontSize).toBe(70)
    expect(r.settings).toEqual({ width: 1920, height: 1080, fps: 30 }) // has clips: size kept
    expect(r.report.join(' ')).toMatch(/Kept the project size/)

    const empty = project()
    expect(applyTemplate(empty, t).settings).toEqual({ width: 1280, height: 720, fps: 24 })
    expect(applyTemplate(target, applyTemplate(target, t) && t).tracks.filter((x) => x.name === 'Narration')).toHaveLength(1) // idempotent
  })
  it('reports when there is nothing to change', () => {
    const p = project()
    const t = captureTemplate(p, { id: 't', name: 'T', description: '' }, DEFAULT_EXPORT_SETTINGS, DEFAULT_RECIPE)
    expect(applyTemplate(p, t).report).toEqual(['Nothing needed changing'])
  })
})

describe('presets', () => {
  it('has valid built-ins and turns a preset into export settings and file names', () => {
    for (const b of BUILTIN_PRESETS) expect(PresetSchema.safeParse(b).success).toBe(true)
    const s = presetToSettings({ ...DEFAULT_EXPORT_SETTINGS, fileName: 'keep' }, BUILTIN_PRESETS[1])
    expect(s).toMatchObject({ resolution: '720p', quality: 'draft', fileName: 'keep' })
    expect(batchFileName('My Video', BUILTIN_PRESETS[0])).toBe('My Video - 1080p')
    expect(batchFileName('  ', { ...BUILTIN_PRESETS[0], suffix: '' })).toBe('export')
  })
})

describe('reusable scenes', () => {
  function scenicProject(): Project {
    const p = project()
    clip(p, 'k1', 'Video 1', 'v1', 100, 300, { sourceInFrame: 30, videoFadeInFrames: 20, videoFadeOutFrames: 20 }) // 100..400
    clip(p, 'k2', 'Audio 1', 'n', 0, 600, { volume: 80, fadeInFrames: 15 })
    p.subtitles.push({ id: 'q', trackId: p.tracks.find((t) => t.kind === 'subtitle')!.id, startFrame: 150, durationFrames: 60, text: 'Hello' })
    return p
  }
  it('captures a range with cut edges, relative timing and no fade on a cut edge', () => {
    const p = scenicProject()
    const r = captureScene(p, { id: 's', name: ' Intro ', startFrame: 200, endFrame: 500 }, abs)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(SceneSchema.safeParse(r.scene).success).toBe(true)
    expect(r.scene).toMatchObject({ name: 'Intro', fps: 30, durationFrames: 300 })
    const video = r.scene.clips.find((c) => c.media.kind === 'video')!
    expect(video).toMatchObject({ relStart: 0, sourceIn: 30 + 100, duration: 200, videoFadeIn: 0, videoFadeOut: 20 }) // left edge was cut, right edge is the clip's own end
    const voice = r.scene.clips.find((c) => c.media.kind === 'audio')!
    expect(voice).toMatchObject({ relStart: 0, sourceIn: 200, duration: 300, fadeIn: 0, volume: 80 })
    expect(r.scene.subtitles).toEqual([{ track: { ordinal: 0 }, relStart: 0, duration: 10, text: 'Hello' }])
    expect(sceneMedia(r.scene).map((m) => m.name)).toEqual(['a.mp4', 'voice.wav'])
    expect(captureScene(p, { id: 's', name: 'x', startFrame: 900, endFrame: 1000 }, abs)).toMatchObject({ ok: false })
    expect(captureScene(p, { id: 's', name: 'x', startFrame: 10, endFrame: 10 }, abs)).toMatchObject({ ok: false })
  })
  it('inserts a scene into another project at the first free spot, adding tracks if needed', () => {
    const src = scenicProject()
    const scene = (captureScene(src, { id: 's', name: 'S', startFrame: 100, endFrame: 400 }, abs) as { ok: true; scene: Parameters<typeof insertScene>[1] }).scene
    const target = project()
    clip(target, 'busy', 'Video 1', 'v1', 0, 200) // occupies 0..200 on Video 1
    const r = insertScene(target, scene, 0, lookup(target))
    expect(r.ok ? 'ok' : r.error).toBe('ok')
    if (!r.ok) return
    expect(r.start).toBe(200) // pushed after the busy clip
    expect(r.report.join(' ')).toContain('Moved later')
    const inserted = r.clips.filter((c) => c.id !== 'busy')
    expect(inserted).toHaveLength(2)
    expect(Math.min(...inserted.map((c) => c.startFrame))).toBe(200)
    expect(validateClips({ ...target, tracks: r.tracks, clips: r.clips })).toEqual([])
    expect(validateSubtitles({ tracks: r.tracks, subtitles: r.subtitles })).toEqual([])
    expect(target.clips).toHaveLength(1) // input untouched
  })
  it('creates missing tracks, converts frame rates, and clamps to the source', () => {
    const src = scenicProject()
    const scene = (captureScene(src, { id: 's', name: 'S', startFrame: 100, endFrame: 400 }, abs) as { ok: true; scene: Parameters<typeof insertScene>[1] }).scene
    const target = project()
    target.settings.fps = 60
    target.tracks = target.tracks.filter((t) => t.name !== 'Audio 1' && t.name !== 'Audio 2')
    target.media = target.media.map((a) => (a.id === 'v1' ? { ...a, durationMs: 4_000 } : a)) // shorter source
    const r = insertScene(target, scene, 60, lookup(target))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tracks.some((t) => t.kind === 'audio')).toBe(true)
    const v = r.clips.find((c) => c.assetId === 'v1')!
    expect(v.startFrame).toBe(60 + 0)
    expect(v.sourceInFrame + v.durationFrames).toBeLessThanOrEqual(240) // 4 s at 60 fps
    expect(validateClips({ ...target, tracks: r.tracks, clips: r.clips })).toEqual([])
  })
  it('refuses when media is missing or a needed track is locked', () => {
    const src = scenicProject()
    const scene = (captureScene(src, { id: 's', name: 'S', startFrame: 100, endFrame: 400 }, abs) as { ok: true; scene: Parameters<typeof insertScene>[1] }).scene
    const target = project()
    expect(insertScene(target, scene, 0, () => null)).toMatchObject({ ok: false })
    target.tracks.find((t) => t.name === 'Video 1')!.locked = true
    expect(insertScene(target, scene, 0, lookup(target))).toMatchObject({ ok: false, error: expect.stringMatching(/locked/) })
  })
})

describe('automatic scene assembly', () => {
  const ids = (...a: string[]) => a
  it('lays scenes out in order with fades, narration and music following the recipe', () => {
    const p = project()
    const r = assembleScenes(p, { sceneAssetIds: ids('v1', 'v2'), narrationAssetId: 'n', musicAssetId: 'm', mode: 'replace' }, DEFAULT_RECIPE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const q = { ...p, tracks: r.tracks, clips: r.clips }
    const name = (id: string) => r.tracks.find((t) => t.id === id)!.name
    const v = r.clips.filter((c) => name(c.trackId) === 'Video 1').sort((a, b) => a.startFrame - b.startFrame)
    expect(v.map((c) => [c.assetId, c.startFrame, c.durationFrames])).toEqual([['v1', 0, 300], ['v2', 300, 180]])
    expect(v.every((c) => c.videoFadeInFrames === 15 && c.videoFadeOutFrames === 15)).toBe(true)
    const voice = r.clips.find((c) => c.assetId === 'n')!
    expect([name(voice.trackId), voice.startFrame, voice.durationFrames]).toEqual(['Audio 1', 0, 1200])
    const music = r.clips.find((c) => c.assetId === 'm')!
    expect([name(music.trackId), music.volume, music.durationFrames, music.fadeInFrames, music.fadeOutFrames]).toEqual(['Audio 2', 30, 1200, 30, 90]) // trimmed to the longest of narration and scenes
    expect(r.report.totalSeconds).toBe(40)
    expect(r.report.notes.join(' ')).toMatch(/longer than the scenes/)
    expect(validateClips(q)).toEqual([])
  })
  it('stretches still images to fit the narration', () => {
    const p = project()
    const r = assembleScenes(p, { sceneAssetIds: ids('v2', 'i1', 'i2'), narrationAssetId: 'n', mode: 'replace' }, { ...DEFAULT_RECIPE, fadeSeconds: 0 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const stills = r.clips.filter((c) => c.assetId === 'i1' || c.assetId === 'i2')
    // narration 40 s - video 6 s = 34 s for two stills = 17 s each
    expect(stills.map((c) => c.durationFrames)).toEqual([510, 510])
    const end = Math.max(...r.clips.filter((c) => c.assetId !== 'n').map((c) => c.startFrame + c.durationFrames))
    expect(end).toBe(1200)
    expect(r.report.notes.join(' ')).toMatch(/17\.0 s/)
    const noFit = assembleScenes(p, { sceneAssetIds: ids('i1'), narrationAssetId: 'n', mode: 'replace' }, { ...DEFAULT_RECIPE, fitToNarration: false, stillSeconds: 4 })
    expect(noFit.ok && noFit.clips.find((c) => c.assetId === 'i1')!.durationFrames).toBe(120)
  })
  it('replace clears only the recipe tracks; append continues after the video track', () => {
    const p = project()
    clip(p, 'keep', 'Video 2', 'v2', 0, 100)
    clip(p, 'old', 'Video 1', 'v1', 0, 200)
    const rep = assembleScenes(p, { sceneAssetIds: ids('v2'), mode: 'replace' }, DEFAULT_RECIPE)
    expect(rep.ok && rep.clips.some((c) => c.id === 'keep')).toBe(true)
    expect(rep.ok && rep.clips.some((c) => c.id === 'old')).toBe(false)
    const app = assembleScenes(p, { sceneAssetIds: ids('v2'), narrationAssetId: 'n', mode: 'append' }, DEFAULT_RECIPE)
    expect(app.ok).toBe(true)
    if (!app.ok) return
    expect(app.clips.some((c) => c.id === 'old')).toBe(true)
    expect(app.clips.find((c) => c.assetId === 'v2' && c.id !== 'keep')!.startFrame).toBe(200)
    expect(app.clips.find((c) => c.assetId === 'n')!.startFrame).toBe(200)
    expect(validateClips({ ...p, tracks: app.tracks, clips: app.clips })).toEqual([])
  })
  it('notes a short music file, creates missing tracks, and rejects bad input', () => {
    const p = project()
    p.media = p.media.map((a) => (a.id === 'm' ? { ...a, durationMs: 5_000 } : a))
    p.tracks = p.tracks.filter((t) => t.name !== 'Audio 2')
    const r = assembleScenes(p, { sceneAssetIds: ids('v1'), musicAssetId: 'm', mode: 'replace' }, { ...DEFAULT_RECIPE, musicFadeInSeconds: 0, musicFadeOutSeconds: 1 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tracks.some((t) => t.name === 'Audio 2' && t.kind === 'audio')).toBe(true)
    expect(r.report.notes.join(' ')).toMatch(/shorter than the video/)
    expect(assembleScenes(p, { sceneAssetIds: [], mode: 'replace' }, DEFAULT_RECIPE)).toMatchObject({ ok: false })
    expect(assembleScenes(p, { sceneAssetIds: ids('n'), mode: 'replace' }, DEFAULT_RECIPE)).toMatchObject({ ok: false })
    expect(assembleScenes(p, { sceneAssetIds: ids('v1'), narrationAssetId: 'v2', mode: 'replace' }, DEFAULT_RECIPE)).toMatchObject({ ok: false })
    p.tracks.find((t) => t.name === 'Video 1')!.locked = true
    expect(assembleScenes(p, { sceneAssetIds: ids('v1'), mode: 'replace' }, DEFAULT_RECIPE)).toMatchObject({ ok: false, error: expect.stringMatching(/locked/) })
  })
  it('never produces an invalid timeline for random inputs', () => {
    let seed = 5
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n)
    const pool = ['v1', 'v2', 'i1', 'i2']
    for (let round = 0; round < 200; round++) {
      const p = project()
      if (rnd(2)) clip(p, 'e', 'Video 1', 'v1', rnd(300), 1 + rnd(200))
      const input = { sceneAssetIds: Array.from({ length: 1 + rnd(5) }, () => pool[rnd(4)]), narrationAssetId: rnd(2) ? 'n' : null, musicAssetId: rnd(2) ? 'm' : null, mode: rnd(2) ? ('replace' as const) : ('append' as const) }
      const r = assembleScenes(p, input, { ...DEFAULT_RECIPE, fadeSeconds: rnd(40) / 10, stillSeconds: 0.5 + rnd(100) / 10, fitToNarration: !!rnd(2) })
      if (r.ok) expect(validateClips({ ...p, tracks: r.tracks, clips: r.clips }), `round ${round}`).toEqual([])
    }
  })
})
