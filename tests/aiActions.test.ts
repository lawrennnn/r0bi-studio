import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiPlanRequest, R0biApi } from '../shared/api'
import { createEmptyProject, type Clip, type MediaAsset } from '../shared/project'
import { DEFAULT_EXPORT_SETTINGS } from '../shared/render'
import { validateClips } from '../shared/timeline'
import { useProjectStore } from '../src/store/projectStore'
import { useUiStore } from '../src/store/uiStore'
import { useAiStore } from '../src/store/aiStore'
import { useMediaStore } from '../src/store/mediaStore'
import { useExportStore } from '../src/store/exportStore'
import { applyPlan, askAssistant, askToFix, discardPlan, loadAiStatus } from '../src/lib/aiActions'

const asset = (id: string, kind: MediaAsset['kind'], name: string, ms = 20_000): MediaAsset => ({
  id, kind, name, path: `C:\\Users\\Ly\\Secret\\${name}`, pathKind: 'absolute', sizeBytes: 1, durationMs: kind === 'image' ? 0 : ms, width: 1920, height: 1080, fpsNum: 30, fpsDen: 1,
  videoCodec: kind === 'audio' ? null : 'h264', audioCodec: kind === 'image' ? null : 'aac', sampleRate: 48000, channels: 2, thumbnail: null, proxy: null, importedAt: ''
})

let replies: unknown[]
let requests: AiPlanRequest[]
let planImpl: (req: AiPlanRequest) => Promise<unknown>

beforeEach(() => {
  replies = []
  requests = []
  planImpl = async (req) => {
    requests.push(req)
    const plan = replies.shift()
    return plan === undefined ? { ok: false, error: 'No reply queued' } : { ok: true, data: { plan, usage: { inputTokens: 100, outputTokens: 20 }, model: 'claude-sonnet-5-5' } }
  }
  vi.stubGlobal('window', {
    r0bi: {
      ai: {
        getSettings: async () => ({ ok: true, data: { hasKey: true, keyHint: 'sk-ant-…1234', model: 'claude-sonnet-5-5', encryptionAvailable: true } }),
        plan: (req: AiPlanRequest) => planImpl(req),
        cancel: async () => ({ ok: true, data: null })
      }
    } as unknown as R0biApi
  })
  const p = createEmptyProject('Ep')
  p.settings = { width: 1920, height: 1080, fps: 30 }
  p.media = [asset('m1', 'video', 'intro.mp4'), asset('m2', 'audio', 'music.mp3', 60_000)]
  const t = (n: string) => p.tracks.find((x) => x.name === n)!.id
  const clip = (id: string, track: string, a: string, start: number, dur: number): Clip => ({ id, trackId: t(track), assetId: a, startFrame: start, sourceInFrame: 0, durationFrames: dur, volume: 100, fadeInFrames: 0, fadeOutFrames: 0, videoFadeInFrames: 0, videoFadeOutFrames: 0 })
  p.clips = [clip('k1', 'Video 1', 'm1', 0, 600), clip('k2', 'Audio 1', 'm2', 0, 900)]
  useProjectStore.getState().load(p, '/tmp/p')
  useUiStore.getState().patch({ playhead: 0, selectedClipId: null, selectedCueId: null })
  useAiStore.setState({ messages: [], busy: false, status: null, includeThumbnails: false })
  useExportStore.setState({ settings: DEFAULT_EXPORT_SETTINGS })
  useMediaStore.setState({ thumbs: {} })
})
afterEach(() => vi.unstubAllGlobals())

const s = () => useProjectStore.getState()
const msgs = () => useAiStore.getState().messages
const lastPlanMsg = () => [...msgs()].reverse().find((m) => m.plan)!

describe('assistant flow', () => {
  it('needs a key, and never calls the API without one', async () => {
    await askAssistant('shorten the intro')
    expect(msgs().at(-1)).toMatchObject({ role: 'error' })
    expect(requests).toHaveLength(0)
  })

  it('asks, shows a checked plan, and changes nothing until applied', async () => {
    await loadAiStatus()
    replies.push({ summary: 'Shorten the intro to 5 seconds.', commands: [{ command: 'trim_clip', clip: 'c1', newEndSeconds: 5 }] })
    const before = structuredClone(s().project)
    await askAssistant('Shorten the introduction')
    const m = lastPlanMsg()
    expect(m.text).toBe('Shorten the intro to 5 seconds.')
    expect(m.plan!.exec.ok).toBe(true)
    expect(m.plan!.exec.steps[0].text).toBe('Trim "intro.mp4" to 0.00 s – 5.00 s')
    expect(m.plan!.status).toBe('pending')
    expect(s().project).toEqual(before) // nothing happened yet
    expect(useAiStore.getState().busy).toBe(false)
  })

  it('sends only metadata with short ids: no paths, no real ids, no thumbnails by default', async () => {
    await loadAiStatus()
    useUiStore.getState().patch({ selectedClipId: 'k1' })
    replies.push({ summary: 'Nothing to do.', commands: [] })
    await askAssistant('hello')
    const sent = JSON.stringify(requests[0])
    expect(sent).not.toContain('Secret')
    expect(sent).not.toMatch(/k1|m1/)
    expect(requests[0].thumbnails).toEqual([])
    expect((requests[0].context as { selection: { clip: string } }).selection.clip).toBe('c1')
  })

  it('sends small thumbnails only when the user turned that on', async () => {
    await loadAiStatus()
    useMediaStore.setState({ thumbs: { m1: 'data:image/jpeg;base64,QUJD', m2: 'data:image/png;base64,REVG' } })
    useAiStore.getState().patch({ includeThumbnails: true })
    replies.push({ summary: 'ok', commands: [] })
    await askAssistant('what do you see')
    expect(requests[0].thumbnails).toEqual([{ alias: 'a1', mediaType: 'image/jpeg', data: 'QUJD' }]) // audio has none; only used visual media
  })

  it('applies a plan as ONE undo step, including export settings, then undo restores the timeline', async () => {
    await loadAiStatus()
    replies.push({
      summary: 'Fade the music and export at 720p.',
      commands: [
        { command: 'set_volume', clip: 'c2', volumePercent: 40, fadeOutSeconds: 3 },
        { command: 'add_transition', type: 'fade_in', clip: 'c1', durationSeconds: 1 },
        { command: 'split_clip', clip: 'c1', atSeconds: 10 },
        { command: 'set_export_settings', resolution: '720p' }
      ]
    })
    await askAssistant('polish it')
    const id = lastPlanMsg().id
    const undoDepth = s().past.length
    expect(applyPlan(id)).toBe(true)
    expect(s().past.length).toBe(undoDepth + 1) // one step for four commands
    expect(s().project!.clips).toHaveLength(3)
    expect(s().project!.clips.find((c) => c.id === 'k2')).toMatchObject({ volume: 40, fadeOutFrames: 90 })
    expect(useExportStore.getState().settings.resolution).toBe('720p')
    expect(lastPlanMsg().plan!.status).toBe('applied')
    expect(validateClips(s().project!)).toEqual([])
    s().undo()
    expect(s().project!.clips).toHaveLength(2)
    expect(s().project!.clips.find((c) => c.id === 'k2')!.volume).toBe(100)
    expect(applyPlan(id)).toBe(false) // cannot be applied twice
  })

  it('re-checks before applying: a plan broken by later edits changes nothing', async () => {
    await loadAiStatus()
    replies.push({ summary: 'Delete the intro.', commands: [{ command: 'delete_clip', clip: 'c1' }] })
    await askAssistant('remove the intro')
    s().commit((d) => void (d.clips = d.clips.filter((c) => c.id !== 'k1'))) // user deletes it first
    const depth = s().past.length
    expect(applyPlan(lastPlanMsg().id)).toBe(false)
    expect(s().past.length).toBe(depth)
    expect(msgs().at(-1)).toMatchObject({ role: 'error' })
    expect(msgs().at(-1)!.text).toMatch(/no longer be applied/)
  })

  it('shows a plan that cannot work as failed, never applies it, and can ask the assistant to fix it', async () => {
    await loadAiStatus()
    replies.push({ summary: 'Split the intro.', commands: [{ command: 'split_clip', clip: 'c1', atSeconds: 99 }] })
    await askAssistant('split the intro in two')
    const m = lastPlanMsg()
    expect(m.plan!.exec.ok).toBe(false)
    expect(m.plan!.exec.steps[0].status).toBe('failed')
    expect(applyPlan(m.id)).toBe(false)
    replies.push({ summary: 'Split at 5 s instead.', commands: [{ command: 'split_clip', clip: 'c1', atSeconds: 5 }] })
    askToFix(m.id)
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1].request).toMatch(/could not be applied/)
    expect(requests[1].history.map((h) => h.role)).toEqual(['user', 'assistant'])
  })

  it('shows invalid or malicious replies as errors and changes nothing', async () => {
    await loadAiStatus()
    const before = structuredClone(s().project)
    for (const bad of [{ summary: 'x', commands: [{ command: 'run_shell', cmd: 'format c:' }] }, 'not an object', { summary: 'x', commands: [{ command: 'delete_clip', clip: 'c1', path: 'C:\\' }] }]) {
      replies.push(bad)
      await askAssistant('do something')
      expect(msgs().at(-1)!.role).toBe('error')
      expect(msgs().at(-1)!.text).toMatch(/not a valid plan/)
    }
    expect(s().project).toEqual(before)
  })

  it('reports API errors and cancellation, and can discard a plan', async () => {
    await loadAiStatus()
    planImpl = async () => ({ ok: false, error: 'The API key was rejected. Check it in Settings' })
    await askAssistant('hi')
    expect(msgs().at(-1)!.text).toMatch(/key was rejected/)
    planImpl = async () => ({ ok: false, error: 'Cancelled', cancelled: true })
    await askAssistant('again')
    expect(msgs().at(-1)!.text).toBe('Cancelled.')
    replies.push({ summary: 'ok', commands: [{ command: 'delete_clip', clip: 'c1' }] })
    planImpl = async () => ({ ok: true, data: { plan: replies.shift(), usage: { inputTokens: 1, outputTokens: 1 }, model: 'm' } })
    await askAssistant('delete it')
    discardPlan(lastPlanMsg().id)
    expect(lastPlanMsg().plan!.status).toBe('discarded')
    expect(applyPlan(lastPlanMsg().id)).toBe(false)
    expect(s().project!.clips.some((c) => c.id === 'k1')).toBe(true)
  })

  it('passes a short history and ignores a second request while busy', async () => {
    await loadAiStatus()
    let release: () => void = () => undefined
    planImpl = (req) => {
      requests.push(req)
      return new Promise((resolve) => (release = () => resolve({ ok: true, data: { plan: { summary: 'ok', commands: [] }, usage: { inputTokens: 1, outputTokens: 1 }, model: 'm' } })))
    }
    const first = askAssistant('one')
    await askAssistant('two') // ignored: still busy
    release()
    await first
    expect(requests).toHaveLength(1)
    planImpl = async (req) => (requests.push(req), { ok: true, data: { plan: { summary: 'done', commands: [] }, usage: { inputTokens: 1, outputTokens: 1 }, model: 'm' } })
    await askAssistant('three')
    expect(requests[1].history).toEqual([{ role: 'user', text: 'one' }, { role: 'assistant', text: 'ok [not applied, 0 commands]' }])
  })
})
