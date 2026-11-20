import { describe, expect, it } from 'vitest'
import { Aliases, AI_TOOL, buildAliases, buildContext, buildMessages, executePlan, parseAiPlan, type AiCommand, type AiPlan } from '../shared/ai'
import { createEmptyProject, type Clip, type MediaAsset, type Project } from '../shared/project'
import { DEFAULT_EXPORT_SETTINGS } from '../shared/render'
import { validateClips, validateSubtitles } from '../shared/timeline'

const asset = (id: string, kind: MediaAsset['kind'], name: string, ms = 20_000, audio = kind !== 'image'): MediaAsset => ({
  id, kind, name, path: `/secret/folder/${name}`, pathKind: 'absolute', sizeBytes: 1, durationMs: kind === 'image' ? 0 : ms, width: 1920, height: 1080, fpsNum: 30, fpsDen: 1,
  videoCodec: kind === 'audio' ? null : 'h264', audioCodec: audio ? 'aac' : null, sampleRate: 48000, channels: 2, thumbnail: null, proxy: null, importedAt: ''
})

function sample(): { p: Project; al: Aliases } {
  const p = createEmptyProject('Episode')
  p.settings = { width: 1920, height: 1080, fps: 30 }
  p.media = [asset('m-intro', 'video', 'intro.mp4'), asset('m-main', 'video', 'main.mp4', 60_000), asset('m-music', 'audio', 'music.mp3', 90_000), asset('m-logo', 'image', 'logo.png')]
  const t = (n: string) => p.tracks.find((x) => x.name === n)!.id
  const clip = (id: string, track: string, a: string, start: number, dur: number): Clip => ({ id, trackId: t(track), assetId: a, startFrame: start, sourceInFrame: 0, durationFrames: dur, volume: 100, fadeInFrames: 0, fadeOutFrames: 0, videoFadeInFrames: 0, videoFadeOutFrames: 0 })
  p.clips = [clip('k-intro', 'Video 1', 'm-intro', 0, 300), clip('k-main', 'Video 1', 'm-main', 300, 900), clip('k-music', 'Audio 1', 'm-music', 0, 1200)]
  p.subtitles = [{ id: 'q1', trackId: t('Subtitles 1'), startFrame: 0, durationFrames: 90, text: 'Hello' }]
  return { p, al: buildAliases(p) }
}
// With the sample: tracks t1 Overlay 1, t2 Subtitles 1, t3 Video 1, t4 Video 2, t5 Audio 1, t6 Audio 2; media a1 intro, a2 main, a3 music, a4 logo;
// clips c1 intro (Video 1, 0 s), c2 main (Video 1, 10 s), c3 music (Audio 1); subtitle s1.
const plan = (...commands: AiCommand[]): AiPlan => ({ summary: 'test', commands })
const run = (commands: AiCommand[], p?: Project, al?: Aliases) => {
  const s = sample()
  return executePlan(p ?? s.p, plan(...commands), al ?? buildAliases(p ?? s.p))
}

describe('plan validation', () => {
  it('accepts a valid plan and treats null fields as absent', () => {
    const r = parseAiPlan({ summary: 'Shorten', commands: [{ command: 'trim_clip', clip: 'c1', newStartSeconds: null, newEndSeconds: 5 }], notes: null })
    expect(r.ok).toBe(true)
  })
  it('rejects unknown commands, extra fields, bad numbers and shell-like requests', () => {
    expect(parseAiPlan({ summary: 'x', commands: [{ command: 'run_shell', cmd: 'del /s *' }] }).ok).toBe(false)
    expect(parseAiPlan({ summary: 'x', commands: [{ command: 'delete_clip', clip: 'c1', path: 'C:\\Windows' }] }).ok).toBe(false)
    expect(parseAiPlan({ summary: 'x', commands: [{ command: 'set_volume', clip: 'c1', volumePercent: 500 }] }).ok).toBe(false)
    expect(parseAiPlan({ summary: 'x', commands: [{ command: 'split_clip', clip: 'c1', atSeconds: -1 }] }).ok).toBe(false)
    expect(parseAiPlan({ summary: '', commands: [] }).ok).toBe(false)
    expect(parseAiPlan('rm -rf /').ok).toBe(false)
    expect(parseAiPlan({ summary: 'x', commands: Array.from({ length: 51 }, () => ({ command: 'delete_clip', clip: 'c1' })) }).ok).toBe(false)
    const bad = parseAiPlan({ summary: 'x', commands: [{ command: 'move_clip', clip: 'c1' }] })
    expect(!bad.ok && bad.error).toMatch(/not a valid plan/)
  })
  it('offers the model exactly the allowed commands', () => {
    const enumValues = (AI_TOOL.input_schema.properties.commands.items.properties.command as { enum: readonly string[] }).enum
    expect([...enumValues].sort()).toEqual(['add_audio', 'add_subtitles', 'add_transition', 'delete_clip', 'duplicate_clip', 'move_clip', 'set_export_settings', 'set_volume', 'split_clip', 'trim_clip', 'update_subtitles'])
  })
})

describe('context sent to the model', () => {
  it('uses short ids and contains no file paths, real ids or thumbnails', () => {
    const { p } = sample()
    const { context } = buildContext(p, { playheadFrame: 60, selectedClipId: 'k-main', selectedCueId: null, exportSettings: DEFAULT_EXPORT_SETTINGS })
    const json = JSON.stringify(context)
    expect(json).not.toContain('/secret/folder')
    expect(json).not.toMatch(/k-intro|k-main|m-intro|q1/)
    expect(json).toContain('"id":"c2"')
    expect((context as { selection: { clip: string } }).selection.clip).toBe('c2')
    expect((context as { project: { durationSeconds: number } }).project.durationSeconds).toBe(40)
    expect(json).toContain('intro.mp4')
  })
  it('caps very long subtitle text and reports truncation', () => {
    const { p } = sample()
    p.subtitles[0].text = 'x'.repeat(1000)
    const { context } = buildContext(p, { playheadFrame: 0, selectedClipId: null, selectedCueId: null, exportSettings: DEFAULT_EXPORT_SETTINGS })
    expect(((context as { subtitles: { text: string }[] }).subtitles[0].text).length).toBeLessThan(200)
  })
  it('builds alternating messages ending with the new request, with labelled thumbnails', () => {
    const msgs = buildMessages(
      [{ role: 'assistant', text: 'ignored first' }, { role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }, { role: 'user', text: 'dangling' }],
      'make it shorter', { x: 1 }, [{ alias: 'a2', mediaType: 'image/jpeg', data: 'AAAA' }]
    )
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    const last = msgs.at(-1)!.content as { type: string; text?: string }[]
    expect(last[0].text).toContain('a2')
    expect(last[1].type).toBe('image')
    expect(last.at(-1)!.text).toContain('make it shorter')
  })
})

describe('executing plans', () => {
  it('trims, moves, splits (then refers to the new part), duplicates and deletes', () => {
    const r = run([
      { command: 'trim_clip', clip: 'c1', newEndSeconds: 6 },
      { command: 'split_clip', clip: 'c2', atSeconds: 20 },
      { command: 'delete_clip', clip: 'c2.b' },
      { command: 'duplicate_clip', clip: 'c1' },
      { command: 'move_clip', clip: 'c1.copy', startSeconds: 40, track: 't4' }
    ])
    expect(r.error).toBeNull()
    expect(r.ok).toBe(true)
    expect(r.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
    const clips = r.project.clips
    expect(clips.find((c) => c.id === 'k-intro')!.durationFrames).toBe(180)
    expect(clips.find((c) => c.id === 'k-main')!.durationFrames).toBe(300) // 10 s .. 20 s
    expect(clips.filter((c) => c.assetId === 'm-main')).toHaveLength(1) // second half deleted
    const copy = clips.find((c) => c.assetId === 'm-intro' && c.id !== 'k-intro')!
    expect(copy.startFrame).toBe(1200)
    expect(r.project.tracks.find((t) => t.id === copy.trackId)!.name).toBe('Video 2')
    expect(validateClips(r.project)).toEqual([])
  })
  it('describes each step in plain language before anything is applied', () => {
    const r = run([{ command: 'trim_clip', clip: 'c1', newEndSeconds: 6 }, { command: 'add_transition', type: 'fade_out', clip: 'c2', durationSeconds: 2 }])
    expect(r.steps[0].text).toBe('Trim "intro.mp4" to 0.00 s – 6.00 s')
    expect(r.steps[1].text).toBe('Fade "main.mp4" out over 2.00 s')
  })
  it('does picture transitions, including dip to black across a cut', () => {
    const r = run([{ command: 'add_transition', type: 'dip_to_black', clip: 'c1', nextClip: 'c2', durationSeconds: 0.5 }, { command: 'add_transition', type: 'fade_in', clip: 'c1', durationSeconds: 1 }])
    expect(r.ok).toBe(true)
    expect(r.project.clips.find((c) => c.id === 'k-intro')).toMatchObject({ videoFadeOutFrames: 15, videoFadeInFrames: 30 })
    expect(r.project.clips.find((c) => c.id === 'k-main')).toMatchObject({ videoFadeInFrames: 15 })
    const hard = run([{ command: 'add_transition', type: 'hard_cut', clip: 'c1' }], r.project, buildAliases(r.project))
    expect(hard.project.clips.find((c) => c.id === 'k-intro')).toMatchObject({ videoFadeInFrames: 0, videoFadeOutFrames: 0 })
    expect(run([{ command: 'add_transition', type: 'fade_in', clip: 'c3' }]).ok).toBe(false) // audio clip has no picture
    expect(run([{ command: 'add_transition', type: 'dip_to_black', clip: 'c1' }]).error).toMatch(/nextClip/)
  })
  it('sets clip volume and fades, and track level', () => {
    const r = run([
      { command: 'set_volume', clip: 'c3', volumePercent: 30, fadeInSeconds: 2, fadeOutSeconds: 3 },
      { command: 'set_volume', track: 't6', volumePercent: 60 }
    ])
    expect(r.ok).toBe(true)
    expect(r.project.clips.find((c) => c.id === 'k-music')).toMatchObject({ volume: 30, fadeInFrames: 60, fadeOutFrames: 90 })
    expect(r.project.tracks[5].volume).toBe(60)
    expect(run([{ command: 'set_volume', clip: 'c3', track: 't5', volumePercent: 10 }]).ok).toBe(false)
    expect(run([{ command: 'set_volume', clip: 'c3' }]).ok).toBe(false)
    expect(run([{ command: 'set_volume', clip: 'c1', fadeInSeconds: 1 }]).ok).toBe(true)
    expect(run([{ command: 'set_volume', clip: 'c1', volumePercent: 10 }]).project.clips[0].volume).toBe(10)
  })
  it('adds audio to a free spot and subtitles on a new track, and edits subtitles', () => {
    const r = run([
      { command: 'add_audio', asset: 'a3', startSeconds: 5, durationSeconds: 10, volumePercent: 40 },
      { command: 'add_subtitles', cues: [{ startSeconds: 5, durationSeconds: 2, text: 'First' }, { startSeconds: 8, durationSeconds: 3, text: 'Second' }] },
      { command: 'update_subtitles', cue: 'newcue2', text: 'Second (fixed)', durationSeconds: 2 },
      { command: 'update_subtitles', cue: 's1', delete: true }
    ])
    expect(r.error).toBeNull()
    const added = r.project.clips.find((c) => c.assetId === 'm-music' && c.id !== 'k-music')!
    expect(added.volume).toBe(40)
    expect(r.project.tracks.find((t) => t.id === added.trackId)!.kind).toBe('audio')
    expect(r.project.subtitles.map((c) => c.text)).toEqual(['First', 'Second (fixed)'])
    expect(r.project.subtitles[1].durationFrames).toBe(60)
    expect(r.project.tracks.filter((t) => t.kind === 'subtitle')).toHaveLength(2) // Subtitles 1 had a cue, so a new track was made
    expect(validateSubtitles(r.project)).toEqual([])
  })
  it('uses an empty subtitle track when there is one, and refuses overlapping subtitles', () => {
    const { p } = sample()
    p.subtitles = []
    const ok = run([{ command: 'add_subtitles', cues: [{ startSeconds: 0, durationSeconds: 2, text: 'A' }] }], p)
    expect(ok.project.tracks.filter((t) => t.kind === 'subtitle')).toHaveLength(1)
    expect(run([{ command: 'add_subtitles', cues: [{ startSeconds: 0, durationSeconds: 2, text: 'A' }, { startSeconds: 1, durationSeconds: 2, text: 'B' }] }], p).error).toMatch(/overlap each other/)
    expect(run([{ command: 'add_subtitles', track: 't2', cues: [{ startSeconds: 1, durationSeconds: 1, text: 'clash' }] }]).error).toMatch(/already on/)
  })
  it('collects export settings without touching the project', () => {
    const { p, al } = sample()
    const r = executePlan(p, plan({ command: 'set_export_settings', resolution: '720p', quality: 'draft' }), al)
    expect(r.exportPatch).toEqual({ resolution: '720p', quality: 'draft' })
    expect(r.project).toEqual(p)
  })
  it('is all-or-nothing: a failing step leaves the project untouched and skips the rest', () => {
    const { p, al } = sample()
    const before = structuredClone(p)
    const r = executePlan(p, plan({ command: 'delete_clip', clip: 'c1' }, { command: 'split_clip', clip: 'c2', atSeconds: 1 }, { command: 'delete_clip', clip: 'c3' }), al)
    expect(r.ok).toBe(false)
    expect(r.steps.map((s) => s.status)).toEqual(['ok', 'failed', 'skipped'])
    expect(r.steps[1].text).toMatch(/not inside the clip/)
    expect(r.project).toEqual(before)
    expect(p).toEqual(before) // the input is never modified
  })
  it('rejects invented ids, wrong kinds, locked tracks and impossible requests', () => {
    expect(run([{ command: 'delete_clip', clip: 'c99' }]).error).toMatch(/no clip "c99"/)
    expect(run([{ command: 'delete_clip', clip: 'k-intro' }]).ok).toBe(false) // real ids are not aliases
    expect(run([{ command: 'add_audio', asset: 'a1', startSeconds: 0 }]).error).toMatch(/not audio/)
    expect(run([{ command: 'move_clip', clip: 'c1', startSeconds: 0, track: 't5' }]).error).toMatch(/cannot go on/)
    expect(run([{ command: 'trim_clip', clip: 'c1' }]).error).toMatch(/needs/)
    expect(run([{ command: 'trim_clip', clip: 'c1', newStartSeconds: 50 }]).error).toMatch(/after the clip ends/)
    const { p, al } = sample()
    p.tracks[2].locked = true
    expect(executePlan(p, plan({ command: 'delete_clip', clip: 'c1' }), al).error).toMatch(/locked/)
  })
  it('limits trims to the source and neighbours and says so', () => {
    const r = run([{ command: 'trim_clip', clip: 'c1', newEndSeconds: 30 }]) // c1's source is 20 s but c2 starts at 10 s
    expect(r.ok).toBe(true)
    expect(r.steps[0].text).toContain('limited')
    expect(r.project.clips.find((c) => c.id === 'k-intro')!.durationFrames).toBe(300)
  })
  it('reports a clip that disappeared after the plan was made', () => {
    const { p, al } = sample()
    p.clips = p.clips.filter((c) => c.id !== 'k-intro')
    expect(executePlan(p, plan({ command: 'trim_clip', clip: 'c1', newEndSeconds: 3 }), al).error).toMatch(/no clip "c1"/)
  })
  it('never throws and always leaves a valid timeline, whatever random plan it is given', () => {
    let seed = 99
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n)
    const pick = <T,>(a: readonly T[]) => a[rnd(a.length)]
    const clipsA = ['c1', 'c2', 'c3', 'c1.b', 'c2.b', 'c1.copy', 'new1', 'c9']
    const times = () => rnd(80) / 2
    for (let round = 0; round < 300; round++) {
      const cmds: AiCommand[] = Array.from({ length: 1 + rnd(5) }, () => {
        switch (rnd(9)) {
          case 0: return { command: 'trim_clip', clip: pick(clipsA), newStartSeconds: rnd(2) ? times() : undefined, newEndSeconds: rnd(2) ? times() : undefined }
          case 1: return { command: 'move_clip', clip: pick(clipsA), startSeconds: times(), track: rnd(2) ? pick(['t1', 't3', 't4', 't5', 't6']) : undefined }
          case 2: return { command: 'split_clip', clip: pick(clipsA), atSeconds: times() }
          case 3: return { command: 'delete_clip', clip: pick(clipsA) }
          case 4: return { command: 'duplicate_clip', clip: pick(clipsA), startSeconds: rnd(2) ? times() : undefined }
          case 5: return { command: 'add_transition', type: pick(['fade_in', 'fade_out', 'dip_to_black', 'hard_cut'] as const), clip: pick(clipsA), nextClip: pick(clipsA), durationSeconds: 0.1 + rnd(30) / 10 }
          case 6: return { command: 'set_volume', clip: pick(clipsA), volumePercent: rnd(101), fadeInSeconds: rnd(2) ? rnd(20) : undefined, fadeOutSeconds: rnd(2) ? rnd(20) : undefined }
          case 7: return { command: 'add_audio', asset: pick(['a1', 'a3']), startSeconds: times(), durationSeconds: rnd(2) ? 1 + rnd(50) : undefined }
          default: return { command: 'add_subtitles', cues: Array.from({ length: 1 + rnd(3) }, (_, i) => ({ startSeconds: times() + i * 3, durationSeconds: 1 + rnd(3), text: 'x' })) }
        }
      })
      const { p, al } = sample()
      const before = structuredClone(p)
      const r = executePlan(p, plan(...cmds), al)
      expect(p).toEqual(before)
      if (r.ok) expect([...validateClips(r.project), ...validateSubtitles(r.project)]).toEqual([])
      else expect(r.project).toEqual(before)
    }
  })
})
