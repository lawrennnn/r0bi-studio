import { z } from 'zod'
import { makeTrack, ProjectSettingsSchema, SubtitleStyleSchema, TRACK_KINDS, type Clip, type MediaAsset, type Project, type SubtitleCue, type Track, type TrackKind } from './project'
import { ExportSettingsSchema, QUALITIES, RESOLUTIONS, ENCODERS, type ExportSettings } from './render'
import { assetFrames, canPlace, clipEnd, normalizeFades, validateClips, validateSubtitles } from './timeline'

/**
 * Automation: episode templates, reusable scenes, automatic scene assembly and export presets.
 * Pure functions on plain data, so everything here is tested without a window.
 */

// ---- Assembly recipe --------------------------------------------------------------------------

export const RecipeSchema = z.object({
  videoTrack: z.string().trim().min(1).max(40),
  narrationTrack: z.string().trim().min(1).max(40),
  musicTrack: z.string().trim().min(1).max(40),
  /** How long a still image stays on screen (unless fitted to the narration). */
  stillSeconds: z.number().min(0.5).max(60),
  /** Picture fade at the start and end of every scene (a dip to black between scenes). 0 = hard cuts. */
  fadeSeconds: z.number().min(0).max(5),
  narrationVolume: z.number().int().min(0).max(100),
  musicVolume: z.number().int().min(0).max(100),
  musicFadeInSeconds: z.number().min(0).max(30),
  musicFadeOutSeconds: z.number().min(0).max(30),
  /** Stretch the still images so the scenes last as long as the narration. */
  fitToNarration: z.boolean()
})
export type Recipe = z.infer<typeof RecipeSchema>

export const DEFAULT_RECIPE: Recipe = {
  videoTrack: 'Video 1',
  narrationTrack: 'Audio 1',
  musicTrack: 'Audio 2',
  stillSeconds: 5,
  fadeSeconds: 0.5,
  narrationVolume: 100,
  musicVolume: 30,
  musicFadeInSeconds: 1,
  musicFadeOutSeconds: 3,
  fitToNarration: true
}

// ---- Templates --------------------------------------------------------------------------------

export const TemplateTrackSchema = z.object({
  kind: z.enum(TRACK_KINDS),
  name: z.string().min(1).max(40),
  muted: z.boolean(),
  locked: z.boolean(),
  visible: z.boolean(),
  volume: z.number().int().min(0).max(100),
  subtitleStyle: SubtitleStyleSchema.optional()
})

export const TemplateSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300),
  createdAt: z.string(),
  settings: ProjectSettingsSchema,
  tracks: z.array(TemplateTrackSchema).min(1).max(64),
  exportSettings: ExportSettingsSchema.omit({ fileName: true, outputDir: true }),
  recipe: RecipeSchema
})
export type Template = z.infer<typeof TemplateSchema>

export function captureTemplate(
  project: Project,
  meta: { id: string; name: string; description: string },
  exportSettings: ExportSettings,
  recipe: Recipe
): Template {
  const { fileName: _f, outputDir: _o, ...rest } = exportSettings
  void _f
  void _o
  return {
    id: meta.id,
    name: meta.name.trim(),
    description: meta.description.trim(),
    createdAt: new Date().toISOString(),
    settings: { ...project.settings },
    tracks: project.tracks.map((t) => ({
      kind: t.kind, name: t.name, muted: t.muted, locked: t.locked, visible: t.visible, volume: t.volume,
      ...(t.kind === 'subtitle' ? { subtitleStyle: t.subtitleStyle ? { ...t.subtitleStyle } : undefined } : {})
    })),
    exportSettings: rest,
    recipe
  }
}

export interface TemplateApplication {
  settings: Project['settings']
  tracks: Track[]
  report: string[]
}

/**
 * Bring a project in line with a template without touching its clips: tracks the template has but
 * the project lacks are added, matching tracks take the template's level and subtitle style, and
 * the resolution/frame rate are only changed while the project is still empty.
 */
export function applyTemplate(project: Project, template: Template): TemplateApplication {
  const report: string[] = []
  const tracks: Track[] = project.tracks.map((t) => ({ ...t }))
  let cursor = -1
  let added = 0
  let styled = 0
  for (const tt of template.tracks) {
    const i = tracks.findIndex((t) => t.kind === tt.kind && t.name === tt.name)
    if (i >= 0) {
      cursor = i
      if (tt.kind === 'subtitle' && tt.subtitleStyle) {
        if (JSON.stringify(tracks[i].subtitleStyle) !== JSON.stringify(tt.subtitleStyle)) styled++
        tracks[i].subtitleStyle = { ...tt.subtitleStyle }
      }
      if (tt.kind === 'audio' || tt.kind === 'video') tracks[i].volume = tt.volume
    } else {
      const t: Track = {
        ...makeTrack(tt.kind, tracks),
        name: tt.name, muted: tt.muted, locked: tt.locked, visible: tt.visible, volume: tt.volume,
        ...(tt.kind === 'subtitle' ? { subtitleStyle: tt.subtitleStyle ? { ...tt.subtitleStyle } : undefined } : {})
      }
      if (!t.subtitleStyle) delete t.subtitleStyle
      tracks.splice(cursor + 1, 0, t)
      cursor++
      added++
    }
  }
  if (added) report.push(`Added ${added} track${added === 1 ? '' : 's'}`)
  if (styled) report.push(`Applied the subtitle style to ${styled} track${styled === 1 ? '' : 's'}`)
  const empty = project.clips.length === 0 && project.subtitles.length === 0
  const same = project.settings.width === template.settings.width && project.settings.height === template.settings.height && project.settings.fps === template.settings.fps
  let settings = project.settings
  if (empty && !same) {
    settings = { ...template.settings }
    report.push(`Set the project to ${settings.width}×${settings.height} at ${settings.fps} fps`)
  } else if (!empty && !same) {
    report.push('Kept the project size and frame rate because it already has clips')
  }
  return { settings, tracks, report: report.length ? report : ['Nothing needed changing'] }
}

// ---- Export presets ---------------------------------------------------------------------------

export const PresetSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(60),
  resolution: z.enum(RESOLUTIONS),
  quality: z.enum(QUALITIES),
  encoder: z.enum(ENCODERS),
  /** Added to the file name in batch exports, e.g. "My Video - 1080p". */
  suffix: z.string().trim().max(40)
})
export type Preset = z.infer<typeof PresetSchema>

export const BUILTIN_PRESETS: Preset[] = [
  { id: 'builtin-youtube-1080p', name: 'YouTube 1080p (High)', resolution: '1080p', quality: 'high', encoder: 'auto', suffix: '1080p' },
  { id: 'builtin-review-720p', name: 'Review draft 720p', resolution: '720p', quality: 'draft', encoder: 'auto', suffix: '720p draft' },
  { id: 'builtin-master-4k', name: '4K master (High)', resolution: '2160p', quality: 'high', encoder: 'auto', suffix: '4K' }
]

export const presetToSettings = (base: ExportSettings, p: Preset): ExportSettings => ({ ...base, resolution: p.resolution, quality: p.quality, encoder: p.encoder })

export function batchFileName(projectName: string, preset: Preset): string {
  return `${projectName.trim() || 'export'}${preset.suffix ? ` - ${preset.suffix}` : ''}`.slice(0, 100)
}

// ---- Reusable scenes --------------------------------------------------------------------------

export const SceneMediaRefSchema = z.object({
  name: z.string().min(1).max(260),
  kind: z.enum(['video', 'audio', 'image']),
  /** Absolute path, so the scene can be used from any project. */
  path: z.string().min(1).max(4096),
  durationMs: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  fpsNum: z.number().int().nonnegative(),
  fpsDen: z.number().int().nonnegative(),
  videoCodec: z.string().max(64).nullable(),
  audioCodec: z.string().max(64).nullable(),
  sampleRate: z.number().int().nonnegative(),
  channels: z.number().int().nonnegative()
})
export type SceneMediaRef = z.infer<typeof SceneMediaRefSchema>

const frames = z.number().int().nonnegative()
export const SceneSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  createdAt: z.string(),
  fps: z.number().int().min(1).max(120),
  durationFrames: z.number().int().min(1),
  clips: z
    .array(
      z.object({
        track: z.object({ kind: z.enum(TRACK_KINDS), ordinal: z.number().int().min(0).max(63) }),
        media: SceneMediaRefSchema,
        relStart: frames,
        sourceIn: frames,
        duration: z.number().int().min(1),
        volume: z.number().int().min(0).max(100),
        fadeIn: frames,
        fadeOut: frames,
        videoFadeIn: frames,
        videoFadeOut: frames
      })
    )
    .max(500),
  subtitles: z
    .array(z.object({ track: z.object({ ordinal: z.number().int().min(0).max(63) }), relStart: frames, duration: z.number().int().min(1), text: z.string().max(2000) }))
    .max(2000)
})
export type Scene = z.infer<typeof SceneSchema>

/** Where a media file lives, as one comparable key (case-insensitive, one slash style). */
export const refKey = (path: string): string => path.replace(/\\/g, '/').toLowerCase()

const ordinalOf = (tracks: readonly Track[], t: Track): number => tracks.filter((x) => x.kind === t.kind).findIndex((x) => x.id === t.id)

/** Save everything between two frames as a reusable scene. Edges are cut, not stretched. */
export function captureScene(
  project: Project,
  meta: { id: string; name: string; startFrame: number; endFrame: number },
  absolutePath: (a: MediaAsset) => string
): { ok: true; scene: Scene } | { ok: false; error: string } {
  const { startFrame: s, endFrame: e } = meta
  if (e <= s) return { ok: false, error: 'The end must be after the start' }
  const tracks = new Map(project.tracks.map((t) => [t.id, t]))
  const assets = new Map(project.media.map((a) => [a.id, a]))
  const clips: Scene['clips'] = []
  for (const c of project.clips) {
    const t = tracks.get(c.trackId)
    const a = assets.get(c.assetId)
    if (!t || !a || clipEnd(c) <= s || c.startFrame >= e) continue
    const from = Math.max(c.startFrame, s)
    const to = Math.min(clipEnd(c), e)
    const cut = normalizeFades({
      ...c,
      startFrame: from - s,
      sourceInFrame: a.kind === 'image' ? 0 : c.sourceInFrame + (from - c.startFrame),
      durationFrames: to - from,
      // A fade belongs to the clip's real edge; a cut edge starts or ends abruptly.
      fadeInFrames: c.startFrame >= s ? c.fadeInFrames : 0,
      fadeOutFrames: clipEnd(c) <= e ? c.fadeOutFrames : 0,
      videoFadeInFrames: c.startFrame >= s ? c.videoFadeInFrames : 0,
      videoFadeOutFrames: clipEnd(c) <= e ? c.videoFadeOutFrames : 0
    })
    clips.push({
      track: { kind: t.kind, ordinal: ordinalOf(project.tracks, t) },
      media: {
        name: a.name, kind: a.kind, path: absolutePath(a), durationMs: a.durationMs, width: a.width, height: a.height, fpsNum: a.fpsNum, fpsDen: a.fpsDen,
        videoCodec: a.videoCodec, audioCodec: a.audioCodec, sampleRate: a.sampleRate, channels: a.channels
      },
      relStart: cut.startFrame, sourceIn: cut.sourceInFrame, duration: cut.durationFrames, volume: c.volume,
      fadeIn: cut.fadeInFrames, fadeOut: cut.fadeOutFrames, videoFadeIn: cut.videoFadeInFrames, videoFadeOut: cut.videoFadeOutFrames
    })
  }
  const subtitles: Scene['subtitles'] = []
  for (const c of project.subtitles) {
    const t = tracks.get(c.trackId)
    if (!t || clipEnd(c) <= s || c.startFrame >= e) continue
    const from = Math.max(c.startFrame, s)
    subtitles.push({ track: { ordinal: ordinalOf(project.tracks, t) }, relStart: from - s, duration: Math.min(clipEnd(c), e) - from, text: c.text })
  }
  if (clips.length === 0 && subtitles.length === 0) return { ok: false, error: 'There is nothing between those times' }
  return { ok: true, scene: { id: meta.id, name: meta.name.trim(), createdAt: new Date().toISOString(), fps: project.settings.fps, durationFrames: e - s, clips, subtitles } }
}

/** The distinct media files a scene needs, in order of first use. */
export function sceneMedia(scene: Scene): SceneMediaRef[] {
  const seen = new Map<string, SceneMediaRef>()
  for (const c of scene.clips) if (!seen.has(refKey(c.media.path))) seen.set(refKey(c.media.path), c.media)
  return [...seen.values()]
}

export interface PlacementResult {
  ok: true
  tracks: Track[]
  clips: Clip[]
  subtitles: SubtitleCue[]
  /** First frame the scene occupies. */
  start: number
  report: string[]
}
export type PlacementFailure = { ok: false; error: string }

function ensureTrack(tracks: Track[], kind: TrackKind, ordinal: number): Track {
  for (;;) {
    const same = tracks.filter((t) => t.kind === kind)
    if (same.length > ordinal) return same[ordinal]
    const t = makeTrack(kind, tracks)
    const last = tracks.map((x) => x.kind).lastIndexOf(kind)
    tracks.splice(last >= 0 ? last + 1 : tracks.length, 0, t)
  }
}

/**
 * Put a saved scene on the timeline at (or after) a frame, on the first spot where all of it fits.
 * `assetFor` maps each of the scene's media files to an asset already in the project.
 */
export function insertScene(project: Project, scene: Scene, atFrame: number, assetFor: (ref: SceneMediaRef) => MediaAsset | null): PlacementResult | PlacementFailure {
  const fps = project.settings.fps
  const k = fps / scene.fps
  const scale = (n: number) => Math.round(n * k)
  const tracks: Track[] = project.tracks.map((t) => ({ ...t }))

  const missing = new Set<string>()
  const resolved = scene.clips.map((c) => {
    const a = assetFor(c.media)
    if (!a) missing.add(c.media.name)
    return a
  })
  if (missing.size > 0) return { ok: false, error: `These media files are not available: ${[...missing].slice(0, 5).join(', ')}` }

  const items: { track: Track; rel: number; dur: number; build: (start: number) => Clip | SubtitleCue; isCue: boolean }[] = []
  for (const [i, c] of scene.clips.entries()) {
    const a = resolved[i] as MediaAsset
    const t = ensureTrack(tracks, c.track.kind, c.track.ordinal)
    if (t.locked) return { ok: false, error: `Track ${t.name} is locked` }
    if (!canPlace(t.kind, a.kind)) return { ok: false, error: `${a.name} cannot go on the ${t.kind} track ${t.name}` }
    const total = assetFrames(a, fps)
    let sourceIn = a.kind === 'image' ? 0 : scale(c.sourceIn)
    let dur = Math.max(1, scale(c.duration))
    if (total !== null) {
      sourceIn = Math.min(sourceIn, total - 1)
      dur = Math.max(1, Math.min(dur, total - sourceIn))
    }
    const rel = scale(c.relStart)
    items.push({
      track: t, rel, dur, isCue: false,
      build: (start) =>
        normalizeFades({
          id: crypto.randomUUID(), trackId: t.id, assetId: a.id, startFrame: start + rel, sourceInFrame: sourceIn, durationFrames: dur, volume: c.volume,
          fadeInFrames: scale(c.fadeIn), fadeOutFrames: scale(c.fadeOut), videoFadeInFrames: scale(c.videoFadeIn), videoFadeOutFrames: scale(c.videoFadeOut)
        })
    })
  }
  for (const c of scene.subtitles) {
    const t = ensureTrack(tracks, 'subtitle', c.track.ordinal)
    if (t.locked) return { ok: false, error: `Track ${t.name} is locked` }
    const rel = scale(c.relStart)
    const dur = Math.max(1, scale(c.duration))
    items.push({ track: t, rel, dur, isCue: true, build: (start) => ({ id: crypto.randomUUID(), trackId: t.id, startFrame: start + rel, durationFrames: dur, text: c.text }) })
  }

  const occupied = (t: Track) => [...project.clips.filter((c) => c.trackId === t.id), ...project.subtitles.filter((c) => c.trackId === t.id)]
  const fits = (start: number) => items.every((it) => occupied(it.track).every((o) => !(start + it.rel < clipEnd(o) && o.startFrame < start + it.rel + it.dur)))
  const candidates = new Set<number>([Math.max(0, atFrame)])
  for (const it of items) for (const o of occupied(it.track)) if (clipEnd(o) - it.rel >= atFrame) candidates.add(Math.max(0, clipEnd(o) - it.rel))
  const start = [...candidates].sort((a, b) => a - b).find(fits)
  if (start === undefined) return { ok: false, error: 'There is no room for this scene' }

  const clips = items.filter((i) => !i.isCue).map((i) => i.build(start) as Clip)
  const subtitles = items.filter((i) => i.isCue).map((i) => i.build(start) as SubtitleCue)
  const report = [`Placed ${clips.length} clip${clips.length === 1 ? '' : 's'}${subtitles.length ? ` and ${subtitles.length} subtitle${subtitles.length === 1 ? '' : 's'}` : ''} at ${(start / fps).toFixed(2)} s`]
  if (start > atFrame) report.push('Moved later to find free space')
  if (tracks.length > project.tracks.length) report.push(`Added ${tracks.length - project.tracks.length} track${tracks.length - project.tracks.length === 1 ? '' : 's'}`)
  const result: PlacementResult = { ok: true, tracks, clips: [...project.clips, ...clips], subtitles: [...project.subtitles, ...subtitles], start, report }
  const issues = [...validateClips({ ...project, tracks, clips: result.clips }), ...validateSubtitles({ tracks, subtitles: result.subtitles })]
  return issues.length ? { ok: false, error: `The scene would break a timeline rule (${issues[0]})` } : result
}

// ---- Automatic scene assembly -----------------------------------------------------------------

export interface AssemblyInput {
  /** Scene media in the order they should play. Video and image items. */
  sceneAssetIds: string[]
  narrationAssetId?: string | null
  musicAssetId?: string | null
  /** replace: clear the recipe's three tracks first. append: continue after what is already on the video track. */
  mode: 'replace' | 'append'
}
export interface AssemblyResult {
  ok: true
  tracks: Track[]
  clips: Clip[]
  report: { sceneCount: number; totalSeconds: number; notes: string[] }
}

/**
 * Lay scenes out in order on the video track with the narration and music underneath, following
 * the recipe. Stills can be stretched so the pictures last as long as the narration.
 */
export function assembleScenes(project: Project, input: AssemblyInput, recipe: Recipe): AssemblyResult | PlacementFailure {
  const fps = project.settings.fps
  const sec = (s: number) => Math.round(s * fps)
  const assets = new Map(project.media.map((a) => [a.id, a]))
  const notes: string[] = []

  const scenes: MediaAsset[] = []
  for (const id of input.sceneAssetIds) {
    const a = assets.get(id)
    if (!a || a.kind === 'audio') return { ok: false, error: 'Scenes must be video or image items from the library' }
    scenes.push(a)
  }
  if (scenes.length === 0) return { ok: false, error: 'Choose at least one scene' }
  const narration = input.narrationAssetId ? assets.get(input.narrationAssetId) : undefined
  const music = input.musicAssetId ? assets.get(input.musicAssetId) : undefined
  if ((input.narrationAssetId && narration?.kind !== 'audio') || (input.musicAssetId && music?.kind !== 'audio')) return { ok: false, error: 'Narration and music must be audio items' }

  const tracks: Track[] = project.tracks.map((t) => ({ ...t }))
  const track = (kind: TrackKind, name: string): Track => {
    const found = tracks.find((t) => t.kind === kind && t.name === name)
    if (found) return found
    const t = { ...makeTrack(kind, tracks), name }
    if (!t.subtitleStyle) delete t.subtitleStyle
    const last = tracks.map((x) => x.kind).lastIndexOf(kind)
    tracks.splice(last >= 0 ? last + 1 : tracks.length, 0, t)
    return t
  }
  const vt = track('video', recipe.videoTrack)
  const nt = narration ? track('audio', recipe.narrationTrack) : null
  const mt = music ? track('audio', recipe.musicTrack) : null
  for (const t of [vt, nt, mt]) if (t?.locked) return { ok: false, error: `Track ${t.name} is locked` }

  const used = new Set([vt.id, nt?.id, mt?.id])
  let clips = input.mode === 'replace' ? project.clips.filter((c) => !used.has(c.trackId)) : project.clips.map((c) => ({ ...c }))
  const base = input.mode === 'append' ? Math.max(0, ...clips.filter((c) => c.trackId === vt.id).map(clipEnd)) : 0

  // How long each scene lasts: videos play in full, stills share out the narration (or use the recipe's default).
  const narrationFrames = narration ? (assetFrames(narration, fps) as number) : 0
  const videoFrames = scenes.filter((a) => a.kind === 'video').reduce((n, a) => n + (assetFrames(a, fps) as number), 0)
  const stills = scenes.filter((a) => a.kind === 'image').length
  let stillFrames = sec(recipe.stillSeconds)
  if (recipe.fitToNarration && narration && stills > 0) {
    const room = narrationFrames - videoFrames
    if (room > 0) {
      stillFrames = Math.max(sec(1), Math.min(sec(60), Math.floor(room / stills)))
      notes.push(`Each still image lasts ${(stillFrames / fps).toFixed(1)} s so the pictures fit the narration`)
    } else notes.push('The videos already last longer than the narration, so still images use the default length')
  }

  const fadeBase = sec(recipe.fadeSeconds)
  let t = base
  const clipId = () => crypto.randomUUID()
  const sceneClips: Clip[] = []
  for (const a of scenes) {
    const dur = a.kind === 'image' ? stillFrames : (assetFrames(a, fps) as number)
    const fade = Math.min(fadeBase, Math.floor(dur / 2))
    sceneClips.push({
      id: clipId(), trackId: vt.id, assetId: a.id, startFrame: t, sourceInFrame: 0, durationFrames: dur, volume: 100, fadeInFrames: 0, fadeOutFrames: 0, videoFadeInFrames: fade, videoFadeOutFrames: fade
    })
    t += dur
  }
  const scenesEnd = t
  clips = [...clips, ...sceneClips]

  let end = scenesEnd
  if (narration && nt) {
    clips.push({ id: clipId(), trackId: nt.id, assetId: narration.id, startFrame: base, sourceInFrame: 0, durationFrames: narrationFrames, volume: recipe.narrationVolume, fadeInFrames: 0, fadeOutFrames: 0, videoFadeInFrames: 0, videoFadeOutFrames: 0 })
    end = Math.max(end, base + narrationFrames)
    if (narrationFrames > scenesEnd - base) notes.push('The narration is longer than the scenes, so the picture ends before the narration does')
  }
  if (music && mt) {
    const full = assetFrames(music, fps) as number
    const wanted = end - base
    const dur = Math.min(full, wanted)
    if (full < wanted) notes.push('The music is shorter than the video, so it stops early (music does not loop yet)')
    clips.push(
      normalizeFades({
        id: clipId(), trackId: mt.id, assetId: music.id, startFrame: base, sourceInFrame: 0, durationFrames: dur, volume: recipe.musicVolume,
        fadeInFrames: sec(recipe.musicFadeInSeconds), fadeOutFrames: sec(recipe.musicFadeOutSeconds), videoFadeInFrames: 0, videoFadeOutFrames: 0
      })
    )
  }

  const issues = validateClips({ ...project, tracks, clips })
  if (issues.length > 0) return { ok: false, error: `The assembly would break a timeline rule (${issues[0]})` }
  return { ok: true, tracks, clips, report: { sceneCount: scenes.length, totalSeconds: (end - base) / fps, notes } }
}

