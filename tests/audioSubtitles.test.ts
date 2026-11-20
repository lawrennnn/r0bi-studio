import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyProject, DEFAULT_SUBTITLE_STYLE, migrateProject, type Clip, type MediaAsset } from '../shared/project'
import { cuesToFrames, decodeSubtitleBytes, parseSrt } from '../shared/srt'
import { effectiveGain, fadeGain } from '../shared/audio'
import { normalizeFades, rescaleCues, splitClip, timelineEnd, validateClips, validateSubtitles } from '../shared/timeline'
import { useProjectStore } from '../src/store/projectStore'
import { useUiStore } from '../src/store/uiStore'
import { timeline } from '../src/store/timelineActions'
import { subtitles } from '../src/store/subtitleActions'

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'c', trackId: 't', assetId: 'a', startFrame: 100, sourceInFrame: 0, durationFrames: 100, volume: 100, fadeInFrames: 0, fadeOutFrames: 0, videoFadeInFrames: 0, videoFadeOutFrames: 0, ...over
})

describe('SRT parsing', () => {
  const srt = '\uFEFF1\r\n00:00:01,000 --> 00:00:03,500\r\nHello <i>world</i>\r\n\r\n2\r\n00:00:04.250 --> 00:00:06,000\r\nTwo lines\r\n{\\an8}here\r\n\r\n'
  it('reads BOM, CRLF, dot decimals, multi-line text, and strips simple markup', () => {
    const { cues, warnings } = parseSrt(srt)
    expect(warnings).toEqual([])
    expect(cues).toEqual([
      { startMs: 1000, endMs: 3500, text: 'Hello world' },
      { startMs: 4250, endMs: 6000, text: 'Two lines\nhere' }
    ])
  })
  it('works without index lines and with Khmer text', () => {
    const { cues } = parseSrt('00:00:00,000 --> 00:00:02,000\nសួស្តី ពិភពលោក\n')
    expect(cues[0].text).toBe('សួស្តី ពិភពលោក')
  })
  it('skips broken blocks with a warning and sorts by time', () => {
    const { cues, warnings } = parseSrt('2\n00:00:05,000 --> 00:00:06,000\nB\n\njunk\nnot a time\n\n1\n00:00:01,000 --> 00:00:02,000\nA\n\n3\n00:00:09,000 --> 00:00:08,000\nbackwards')
    expect(cues.map((c) => c.text)).toEqual(['A', 'B'])
    expect(warnings).toHaveLength(2)
  })
  it('converts to integer frames and fixes overlaps without losing cues', () => {
    const frames = cuesToFrames([
      { startMs: 0, endMs: 2000, text: 'a' },
      { startMs: 1500, endMs: 3000, text: 'b' },
      { startMs: 1500, endMs: 2500, text: 'c' }
    ], 30)
    expect(frames[0]).toEqual({ startFrame: 0, durationFrames: 45, text: 'a' })
    expect(frames[1].startFrame).toBe(45)
    expect(frames).toHaveLength(3)
    for (let i = 1; i < frames.length; i++) expect(frames[i].startFrame).toBeGreaterThanOrEqual(frames[i - 1].startFrame + frames[i - 1].durationFrames)
  })
  it('decodes UTF-8 and UTF-16 files', () => {
    const text = '1\n00:00:00,000 --> 00:00:01,000\nសួស្តី\n'
    expect(decodeSubtitleBytes(new TextEncoder().encode(text))).toBe(text)
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    expect(decodeSubtitleBytes(u16)).toBe(text)
  })
})

describe('fades and gain', () => {
  it('ramps up and down linearly and is silent outside the clip', () => {
    const c = clip({ fadeInFrames: 10, fadeOutFrames: 20 })
    expect(fadeGain(c, 99)).toBe(0)
    expect(fadeGain(c, 100)).toBeCloseTo(0.05)
    expect(fadeGain(c, 105)).toBeCloseTo(0.55)
    expect(fadeGain(c, 120)).toBe(1)
    expect(fadeGain(c, 179)).toBe(1)
    expect(fadeGain(c, 180)).toBeCloseTo(0.975)
    expect(fadeGain(c, 199)).toBeCloseTo(0.025)
    expect(fadeGain(c, 200)).toBe(0)
  })
  it('multiplies clip and track level and respects mute', () => {
    const c = clip({ volume: 50 })
    expect(effectiveGain(c, { volume: 80, muted: false }, 150)).toBeCloseTo(0.4)
    expect(effectiveGain(c, { volume: 80, muted: true }, 150)).toBe(0)
  })
  it('keeps fades inside the clip and splits them sensibly', () => {
    expect(normalizeFades(clip({ durationFrames: 30, fadeInFrames: 25, fadeOutFrames: 25 }))).toMatchObject({ fadeInFrames: 25, fadeOutFrames: 5 })
    const [l, r] = splitClip(clip({ fadeInFrames: 10, fadeOutFrames: 10 }), 150, 'r', false)!
    expect([l.fadeInFrames, l.fadeOutFrames, r.fadeInFrames, r.fadeOutFrames]).toEqual([10, 0, 0, 10])
  })
})

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
  proj.media = [asset('v', 'video', 10_000), asset('a', 'audio', 5_000)]
  s().load(proj, '/tmp/t')
  useUiStore.getState().patch({ playhead: 0, selectedClipId: null, selectedCueId: null })
})

describe('audio actions', () => {
  it('sets volume and fades with limits, and merges a slider drag into one undo step', () => {
    const id = timeline.addAsset('a', track('Audio 1'), 0)! // 150 frames
    for (const v of [90, 70, 50, 30]) timeline.setVolume(id, v)
    expect(p().clips[0].volume).toBe(30)
    s().undo() // the whole drag
    expect(p().clips[0].volume).toBe(100)
    timeline.setFade(id, 'in', 100)
    timeline.setFade(id, 'out', 100)
    expect([p().clips[0].fadeInFrames, p().clips[0].fadeOutFrames]).toEqual([100, 50])
    expect(validateClips(p())).toEqual([])
  })
  it('syncs: nudge and start-at-playhead never overlap a neighbour', () => {
    const a = timeline.addAsset('a', track('Audio 1'), 0)!
    timeline.addAsset('a', track('Audio 1'), 200)
    timeline.nudge(a, 100)
    expect(p().clips.find((c) => c.id === a)!.startFrame).toBe(50) // blocked: slides up against the next clip instead of overlapping it
    useUiStore.getState().patch({ playhead: 40 })
    timeline.startAtPlayhead(a)
    expect(p().clips.find((c) => c.id === a)!.startFrame).toBe(40)
    expect(validateClips(p())).toEqual([])
  })
  it('sets track level for the mix', () => {
    timeline.setTrackVolume(track('Audio 2'), 35)
    expect(p().tracks.find((t) => t.name === 'Audio 2')!.volume).toBe(35)
  })
})

describe('subtitle actions', () => {
  const sub = () => track('Subtitles 1')
  it('adds cues at the playhead into free space and selects them', () => {
    useUiStore.getState().patch({ playhead: 30 })
    const a = subtitles.addCue(sub(), undefined, 'one')!
    const b = subtitles.addCue(sub(), 40, 'two')! // overlaps the first (30..90), so it moves to the nearest free spot
    expect(p().subtitles.find((c) => c.id === a)!.startFrame).toBe(30)
    expect(p().subtitles.find((c) => c.id === b)!.startFrame).toBe(90)
    expect(useUiStore.getState().selectedCueId).toBe(b)
    expect(validateSubtitles(p())).toEqual([])
    expect(subtitles.addCue(track('Video 1'), 0)).toBeNull()
  })
  it('edits text (merging typing into one undo step), timing, duplicate and delete', () => {
    const id = subtitles.addCue(sub(), 0, '')!
    for (const t of ['H', 'He', 'Hel', 'Hello']) subtitles.setText(id, t)
    expect(p().subtitles[0].text).toBe('Hello')
    s().undo()
    expect(p().subtitles[0].text).toBe('')
    expect(subtitles.setDuration(id, 15)).toBe(true)
    expect(p().subtitles[0].durationFrames).toBe(15)
    const copy = subtitles.duplicate(id)!
    expect(p().subtitles.find((c) => c.id === copy)!.startFrame).toBe(15)
    expect(subtitles.setDuration(id, 999)).toBe(true) // clamped to the next cue
    expect(p().subtitles.find((c) => c.id === id)!.durationFrames).toBe(15)
    expect(subtitles.remove(copy)).toBe(true)
    expect(validateSubtitles(p())).toEqual([])
  })
  it('imports cues, skipping any that clash with existing ones', () => {
    subtitles.addCue(sub(), 0, 'existing') // 0..60
    const r = subtitles.importCues(sub(), [
      { startFrame: 30, durationFrames: 30, text: 'clash' },
      { startFrame: 60, durationFrames: 30, text: 'ok' }
    ])
    expect(r).toEqual({ added: 1, skipped: 1 })
    expect(p().subtitles.map((c) => c.text)).toEqual(['existing', 'ok'])
  })
  it('styles a track with validation, and rescales cues with the frame rate', () => {
    expect(p().tracks.find((t) => t.id === sub())!.subtitleStyle).toEqual(DEFAULT_SUBTITLE_STYLE)
    expect(subtitles.setStyle(sub(), { fontSize: 72, color: '#ffcc00' })).toBe(true)
    expect(subtitles.setStyle(sub(), { fontSize: 2 })).toBe(false)
    expect(subtitles.setStyle(sub(), { color: 'red' })).toBe(false)
    expect(p().tracks.find((t) => t.id === sub())!.subtitleStyle).toMatchObject({ fontSize: 72, color: '#ffcc00' })
    subtitles.addCue(sub(), 30, 'x')
    timeline.setFps(60)
    expect([p().subtitles[0].startFrame, p().subtitles[0].durationFrames]).toEqual([60, 120])
    expect(rescaleCues([], 30, 60)).toEqual([])
  })
  it('locked tracks refuse edits, and subtitles extend the timeline end', () => {
    const id = subtitles.addCue(sub(), 100, 'late')!
    expect(timelineEnd(p())).toBe(160)
    s().commit((d) => void (d.tracks.find((t) => t.id === sub())!.locked = true))
    expect(subtitles.setText(id, 'no')).toBe(false)
    expect(subtitles.remove(id)).toBe(false)
    expect(subtitles.addCue(sub(), 0)).toBeNull()
  })
  it('stays valid through a long random sequence of audio and subtitle edits', () => {
    let seed = 777
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n)
    const aId = timeline.addAsset('a', track('Audio 1'), 0)!
    for (let step = 0; step < 500; step++) {
      const cues = p().subtitles
      const cue = cues.length ? cues[rnd(cues.length)] : null
      useUiStore.getState().patch({ playhead: rnd(600) })
      switch (rnd(9)) {
        case 0: case 1: subtitles.addCue(sub(), rnd(600), 't'); break
        case 2: if (cue) subtitles.setStart(cue.id, rnd(600)); break
        case 3: if (cue) subtitles.setDuration(cue.id, 1 + rnd(200)); break
        case 4: if (cue) subtitles.duplicate(cue.id); break
        case 5: if (cue) subtitles.remove(cue.id); break
        case 6: timeline.setFade(aId, rnd(2) ? 'in' : 'out', rnd(200)); break
        case 7: timeline.split(); break
        case 8: if (rnd(3) === 0) s().undo(); else if (rnd(3) === 0) s().redo(); else timeline.setDuration(aId, 1 + rnd(150)); break
      }
      expect([...validateSubtitles(p()), ...validateClips(p())], `step ${step}`).toEqual([])
    }
  })
  it('opens a v3 project and gives old subtitle tracks the default look', () => {
    const base = createEmptyProject('Old')
    const v3 = { ...base, schemaVersion: 3, tracks: base.tracks.map(({ volume: _v, subtitleStyle: _s, ...t }) => (void _v, void _s, t)) }
    const { subtitles: _x, ...noSubs } = v3
    void _x
    const m = migrateProject(noSubs)
    expect(m.subtitles).toEqual([])
    expect(m.tracks.find((t) => t.kind === 'subtitle')!.subtitleStyle).toBeUndefined()
    expect(m.tracks.every((t) => t.volume === 100)).toBe(true)
  })
})
