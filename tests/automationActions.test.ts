import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationData, R0biApi } from '../shared/api'
import { BUILTIN_PRESETS, captureScene, DEFAULT_RECIPE, SceneSchema, TemplateSchema, type Scene } from '../shared/automation'
import { createEmptyProject, type Clip, type MediaAsset } from '../shared/project'
import { DEFAULT_EXPORT_SETTINGS } from '../shared/render'
import { validateClips } from '../shared/timeline'
import { useProjectStore } from '../src/store/projectStore'
import { useUiStore } from '../src/store/uiStore'
import { useMediaStore } from '../src/store/mediaStore'
import { useExportStore } from '../src/store/exportStore'
import { useAutomationStore } from '../src/store/automationStore'
import { absolutePath, applyTemplateToProject, assembleNow, insertSceneAtPlayhead, loadAutomation, saveScene, savePreset, saveTemplate } from '../src/lib/automationActions'

const asset = (id: string, kind: MediaAsset['kind'], name: string, ms = 10_000, over: Partial<MediaAsset> = {}): MediaAsset => ({
  id, kind, name, path: `C:\\Media\\${name}`, pathKind: 'absolute', sizeBytes: 1, durationMs: kind === 'image' ? 0 : ms, width: 1920, height: 1080, fpsNum: 30, fpsDen: 1,
  videoCodec: kind === 'audio' ? null : 'h264', audioCodec: kind === 'image' ? null : 'aac', sampleRate: 48000, channels: 2, thumbnail: null, proxy: null, importedAt: '', ...over
})

let store: AutomationData
let importCalls: string[][]

beforeEach(() => {
  store = { templates: [], scenes: [], presets: [] }
  importCalls = []
  const respond = () => ({ ok: true as const, data: structuredClone(store) })
  vi.stubGlobal('window', {
    r0bi: {
      automation: {
        load: async () => respond(),
        save: async (kind: keyof AutomationData, item: unknown) => ((store[kind] as unknown[]).push(item), respond()),
        remove: async () => respond()
      },
      media: {
        importPaths: async (paths: string[]) => {
          importCalls.push(paths)
          return { ok: true, data: { assets: paths.map((p, i) => asset(`imp${importCalls.length}-${i}`, p.endsWith('.png') ? 'image' : /\.(wav|mp3)$/.test(p) ? 'audio' : 'video', p.split('\\').pop() as string, 10_000, { path: p })), thumbs: { x: 'data:image/png;base64,AA' }, failures: [] } }
        }
      }
    } as unknown as R0biApi
  })
  const p = createEmptyProject('Ep')
  p.settings = { width: 1920, height: 1080, fps: 30 }
  p.media = [asset('v1', 'video', 'a.mp4'), asset('v2', 'video', 'b.mp4', 6_000), asset('i1', 'image', 'x.png'), asset('n', 'audio', 'voice.wav', 40_000), asset('m', 'audio', 'music.mp3', 90_000)]
  useProjectStore.getState().load(p, 'E:\\Projects\\Ep')
  useUiStore.getState().patch({ playhead: 0, selectedClipId: null, selectedCueId: null })
  useAutomationStore.setState({ data: null, recipe: DEFAULT_RECIPE, sceneIds: [], narrationId: null, musicId: null, mode: 'replace', notice: null, busy: false })
  useExportStore.setState({ settings: DEFAULT_EXPORT_SETTINGS })
  useMediaStore.setState({ thumbs: {} })
})
afterEach(() => vi.unstubAllGlobals())

const s = () => useProjectStore.getState()
const a = () => useAutomationStore.getState()

describe('automation actions', () => {
  it('joins project-relative paths to the project folder', () => {
    expect(absolutePath('E:\\P\\Ep\\', { path: 'assets/video/a.mp4', pathKind: 'relative' })).toBe('E:\\P\\Ep/assets/video/a.mp4')
    expect(absolutePath('E:\\P', { path: 'C:\\x.mp4', pathKind: 'absolute' })).toBe('C:\\x.mp4')
  })

  it('saves a template from the project and applies one as a single undo step', async () => {
    s().commit((d) => void (d.tracks.find((t) => t.name === 'Audio 2')!.volume = 25))
    useExportStore.getState().set({ resolution: '720p' })
    await saveTemplate('My episode', 'look')
    expect(TemplateSchema.safeParse(store.templates[0]).success).toBe(true)
    expect(a().notice).toMatch(/Saved template/)

    const fresh = createEmptyProject('Other')
    fresh.settings = { width: 640, height: 360, fps: 24 }
    s().load(fresh, 'E:\\Other')
    useExportStore.getState().set({ resolution: '2160p' })
    const depth = s().past.length
    applyTemplateToProject(store.templates[0])
    expect(s().past.length).toBe(depth + 1)
    expect(s().project!.settings).toEqual({ width: 1920, height: 1080, fps: 30 }) // empty project takes the template size
    expect(s().project!.tracks.find((t) => t.name === 'Audio 2')!.volume).toBe(25)
    expect(useExportStore.getState().settings.resolution).toBe('720p')
    s().undo()
    expect(s().project!.settings.fps).toBe(24)
  })

  it('saves a scene from a time range and inserts it, importing media the project lacks, as one undo step', async () => {
    s().commit((d) => {
      const clip = (id: string, track: string, assetId: string, start: number, dur: number): Clip => ({ id, trackId: d.tracks.find((t) => t.name === track)!.id, assetId, startFrame: start, sourceInFrame: 0, durationFrames: dur, volume: 100, fadeInFrames: 0, fadeOutFrames: 0, videoFadeInFrames: 0, videoFadeOutFrames: 0 })
      d.clips = [clip('k1', 'Video 1', 'v1', 0, 300), clip('k2', 'Audio 1', 'n', 0, 300)]
    })
    await saveScene('Opening', 0, 10)
    const scene: Scene = store.scenes[0]
    expect(SceneSchema.safeParse(scene).success).toBe(true)
    expect(scene.clips.map((c) => c.media.path)).toEqual(['C:\\Media\\a.mp4', 'C:\\Media\\voice.wav'])

    // A different project that has none of that media.
    const other = createEmptyProject('Other')
    other.settings = { width: 1920, height: 1080, fps: 30 }
    s().load(other, 'E:\\Other')
    const depth = s().past.length
    await insertSceneAtPlayhead(scene)
    expect(importCalls).toEqual([['C:\\Media\\a.mp4', 'C:\\Media\\voice.wav']])
    expect(s().past.length).toBe(depth + 1) // import + placement together
    expect(s().project!.media).toHaveLength(2)
    expect(s().project!.clips).toHaveLength(2)
    expect(validateClips(s().project!)).toEqual([])
    expect(a().notice).toMatch(/Inserted "Opening".*Imported 2 files/)
    s().undo()
    expect(s().project!.media).toHaveLength(0)
    expect(s().project!.clips).toHaveLength(0)

    // Inserting again where the media already exists does not import anything.
    importCalls = []
    await insertSceneAtPlayhead(scene)
    await insertSceneAtPlayhead(scene)
    expect(importCalls).toHaveLength(1) // only the first insert needed it
    expect(s().project!.clips).toHaveLength(4)
    expect(Math.min(...s().project!.clips.filter((c) => c.startFrame > 0).map((c) => c.startFrame))).toBe(300) // second copy placed after the first
  })

  it('reports a scene it cannot place instead of changing the project', async () => {
    const scene = (captureScene(
      (() => {
        const p = createEmptyProject('S')
        p.settings = { width: 1, height: 1, fps: 30 }
        p.media = [asset('v1', 'video', 'a.mp4')]
        p.clips = [{ id: 'k', trackId: p.tracks.find((t) => t.name === 'Video 1')!.id, assetId: 'v1', startFrame: 0, sourceInFrame: 0, durationFrames: 90, volume: 100, fadeInFrames: 0, fadeOutFrames: 0, videoFadeInFrames: 0, videoFadeOutFrames: 0 }]
        return p
      })(), { id: 's', name: 'S', startFrame: 0, endFrame: 90 }, (m) => m.path) as { ok: true; scene: Scene }).scene
    vi.stubGlobal('window', { r0bi: { media: { importPaths: async () => ({ ok: true, data: { assets: [], thumbs: {}, failures: [{ name: 'a.mp4', error: 'File not found' }] } }) } } })
    const bare = createEmptyProject('Bare')
    bare.settings = { width: 1920, height: 1080, fps: 30 }
    s().load(bare, 'E:\\Bare')
    const before = structuredClone(s().project)
    await insertSceneAtPlayhead(scene)
    expect(s().project).toEqual(before)
    expect(a().notice).toMatch(/not available.*File not found/)
    expect(a().busy).toBe(false)
  })

  it('assembles scenes, narration and music as one undo step and explains what it did', () => {
    useAutomationStore.setState({ sceneIds: ['v1', 'i1', 'v2'], narrationId: 'n', musicId: 'm', mode: 'replace' })
    const depth = s().past.length
    expect(assembleNow()).toBe(true)
    expect(s().past.length).toBe(depth + 1)
    const names = (id: string) => s().project!.tracks.find((t) => t.id === id)!.name
    const v = s().project!.clips.filter((c) => names(c.trackId) === 'Video 1').sort((x, y) => x.startFrame - y.startFrame)
    expect(v.map((c) => c.assetId)).toEqual(['v1', 'i1', 'v2'])
    expect(validateClips(s().project!)).toEqual([])
    expect(a().notice).toMatch(/Assembled 3 scenes, 40\.0 s long/)
    s().undo()
    expect(s().project!.clips).toHaveLength(0)
  })

  it('explains why an assembly cannot run and changes nothing', () => {
    useAutomationStore.setState({ sceneIds: [] })
    expect(assembleNow()).toBe(false)
    expect(a().notice).toMatch(/at least one scene/)
    expect(s().project!.clips).toHaveLength(0)
  })

  it('loads the library and saves a preset from the export settings', async () => {
    await loadAutomation()
    expect(a().data).toEqual({ templates: [], scenes: [], presets: [] })
    useExportStore.getState().set({ resolution: '1440p', quality: 'draft', encoder: 'cpu' })
    await savePreset('Quick review')
    expect(store.presets[0]).toMatchObject({ name: 'Quick review', resolution: '1440p', quality: 'draft', encoder: 'cpu', suffix: 'Quick review' })
    expect(BUILTIN_PRESETS.length).toBeGreaterThan(0)
  })
})
