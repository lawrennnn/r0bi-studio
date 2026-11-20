import { z } from 'zod'

export const CURRENT_SCHEMA_VERSION = 6
export const TRACK_KINDS = ['video', 'audio', 'subtitle', 'overlay'] as const
export type TrackKind = (typeof TRACK_KINDS)[number]

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/)

/** How every cue on one subtitle track is drawn. Sizes are pixels at the project's resolution. */
export const SubtitleStyleSchema = z.object({
  fontFamily: z.string().trim().min(1).max(80),
  fontSize: z.number().int().min(8).max(300),
  bold: z.boolean(),
  color: hexColor,
  outlineWidth: z.number().int().min(0).max(20),
  outlineColor: hexColor,
  bgColor: hexColor,
  /** 0 = no background box. */
  bgOpacity: z.number().int().min(0).max(100),
  /** Vertical centre of the text block as a percentage of the frame height, from the top. */
  positionY: z.number().int().min(0).max(100)
})
export type SubtitleStyle = z.infer<typeof SubtitleStyleSchema>

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontFamily: 'Segoe UI',
  fontSize: 48,
  bold: false,
  color: '#ffffff',
  outlineWidth: 3,
  outlineColor: '#000000',
  bgColor: '#000000',
  bgOpacity: 0,
  positionY: 88
}

export const TrackSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(TRACK_KINDS),
  name: z.string().min(1).max(40),
  muted: z.boolean(),
  locked: z.boolean(),
  visible: z.boolean(),
  /** Track level for the mix, 0-100 percent. */
  volume: z.number().int().min(0).max(100).default(100),
  /** Only used by subtitle tracks; older projects fall back to the default style. */
  subtitleStyle: SubtitleStyleSchema.optional()
})

export const ProjectSettingsSchema = z.object({
  width: z.number().int().min(16).max(7680),
  height: z.number().int().min(16).max(4320),
  fps: z.number().int().min(1).max(120)
})

export const MEDIA_KINDS = ['video', 'audio', 'image'] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

/** Supported import formats (lower-case extension without dot). */
export const MEDIA_EXTENSIONS: Record<string, MediaKind> = {
  mp4: 'video', mov: 'video', mkv: 'video',
  png: 'image', jpg: 'image', jpeg: 'image',
  wav: 'audio', mp3: 'audio', aac: 'audio', m4a: 'audio'
}

export function mediaKindForName(fileName: string): MediaKind | null {
  const m = /\.([^./\\]+)$/.exec(fileName)
  return m ? (MEDIA_EXTENSIONS[m[1].toLowerCase()] ?? null) : null
}

const nonNegInt = z.number().int().nonnegative()

/**
 * A reference to a source file. Originals are never copied or modified.
 * Files inside the project folder are stored relative to it; others by absolute path.
 */
export const MediaAssetSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(MEDIA_KINDS),
  name: z.string().min(1).max(260),
  path: z.string().min(1).max(4096),
  pathKind: z.enum(['relative', 'absolute']),
  sizeBytes: nonNegInt,
  /** Integer milliseconds; 0 for still images. */
  durationMs: nonNegInt,
  width: nonNegInt,
  height: nonNegInt,
  /** Frame rate as an exact fraction (e.g. 30000/1001); 0/0 when not applicable. */
  fpsNum: nonNegInt,
  fpsDen: nonNegInt,
  videoCodec: z.string().max(64).nullable(),
  audioCodec: z.string().max(64).nullable(),
  sampleRate: nonNegInt,
  channels: nonNegInt,
  /** Project-relative paths to generated files. */
  thumbnail: z.string().max(512).nullable(),
  proxy: z.string().max(512).nullable(),
  importedAt: z.string()
})
export type MediaAsset = z.infer<typeof MediaAssetSchema>

/**
 * Picture effects on a clip. Zoom and position animate in a straight line from the clip's first
 * frame to its last. Zoom is a percentage (100 = normal, centred); position is the picture's offset
 * as a percentage of the frame width/height.
 */
export const ClipEffectsSchema = z.object({
  opacity: z.number().int().min(0).max(100).default(100),
  scaleStart: z.number().int().min(100).max(400).default(100),
  scaleEnd: z.number().int().min(100).max(400).default(100),
  posStartX: z.number().int().min(-100).max(100).default(0),
  posStartY: z.number().int().min(-100).max(100).default(0),
  posEndX: z.number().int().min(-100).max(100).default(0),
  posEndY: z.number().int().min(-100).max(100).default(0)
})
export type ClipEffects = z.infer<typeof ClipEffectsSchema>
export const DEFAULT_EFFECTS: ClipEffects = { opacity: 100, scaleStart: 100, scaleEnd: 100, posStartX: 0, posStartY: 0, posEndX: 0, posEndY: 0 }

/**
 * A piece of an asset placed on a track. All times are integer frames at the project frame rate.
 * Source out is derived: sourceInFrame + durationFrames. Clips on one track never overlap.
 */
export const ClipSchema = z.object({
  id: z.string().min(1),
  trackId: z.string().min(1),
  assetId: z.string().min(1),
  startFrame: nonNegInt,
  sourceInFrame: nonNegInt,
  durationFrames: z.number().int().min(1),
  /** Clip level for the mix, 0-100 percent (applies to the sound of video and audio clips). */
  volume: z.number().int().min(0).max(100).default(100),
  fadeInFrames: nonNegInt.default(0),
  fadeOutFrames: nonNegInt.default(0),
  /** Picture fades (opacity ramps) on video/image clips: from/to black, or a dissolve over a lower layer. */
  videoFadeInFrames: nonNegInt.default(0),
  videoFadeOutFrames: nonNegInt.default(0),
  /** Absent means no effects. */
  effects: ClipEffectsSchema.optional(),
  /** A note about this clip, shown in the Scenes panel. */
  note: z.string().max(500).optional()
})
export type Clip = z.infer<typeof ClipSchema>

/** One subtitle. Cues live on subtitle tracks and never overlap within a track. */
export const SubtitleCueSchema = z.object({
  id: z.string().min(1),
  trackId: z.string().min(1),
  startFrame: nonNegInt,
  durationFrames: z.number().int().min(1),
  text: z.string().max(2000)
})
export type SubtitleCue = z.infer<typeof SubtitleCueSchema>

export const ProjectSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  createdAt: z.string(),
  updatedAt: z.string(),
  settings: ProjectSettingsSchema,
  tracks: z.array(TrackSchema).max(64),
  media: z.array(MediaAssetSchema).max(5000),
  clips: z.array(ClipSchema).max(20000),
  subtitles: z.array(SubtitleCueSchema).max(50000)
})

export type Track = z.infer<typeof TrackSchema>
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>
export type Project = z.infer<typeof ProjectSchema>

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; cancelled?: boolean }
export interface ProjectHandle {
  project: Project
  dir: string
  recovered?: boolean
}

export const TRACK_LABEL: Record<TrackKind, string> = {
  video: 'Video',
  audio: 'Audio',
  subtitle: 'Subtitles',
  overlay: 'Overlay'
}

export function makeTrack(kind: TrackKind, existing: readonly Track[]): Track {
  const n = existing.filter((t) => t.kind === kind).length + 1
  return {
    id: crypto.randomUUID(),
    kind,
    name: `${TRACK_LABEL[kind]} ${n}`,
    muted: false,
    locked: false,
    visible: true,
    volume: 100,
    ...(kind === 'subtitle' ? { subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE } } : {})
  }
}

export function createEmptyProject(name: string): Project {
  const now = new Date().toISOString()
  const tracks: Track[] = []
  for (const kind of ['overlay', 'subtitle', 'video', 'video', 'audio', 'audio'] as const) {
    tracks.push(makeTrack(kind, tracks))
  }
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    name: name.trim().slice(0, 80) || 'Untitled project',
    createdAt: now,
    updatedAt: now,
    settings: { width: 1920, height: 1080, fps: 30 },
    tracks,
    media: [],
    clips: [],
    subtitles: []
  }
}

/** Upgrade any supported older project JSON to the current schema. */
export function migrateProject(raw: unknown): Project {
  if (typeof raw !== 'object' || raw === null) throw new Error('This file is not an R0-BI Studio project')
  const version = (raw as { schemaVersion?: unknown }).schemaVersion ?? 1
  if (typeof version !== 'number' || version > CURRENT_SCHEMA_VERSION) {
    throw new Error('This project was created by a newer version of R0-BI Studio')
  }
  let data = { ...(raw as Record<string, unknown>) }
  // Schema migrations, one version step at a time.
  if (version < 2) data = { ...data, schemaVersion: 2, media: [] } // v1 -> v2: media library added
  if (version < 3) data = { ...data, schemaVersion: 3, clips: [] } // v2 -> v3: timeline clips added
  if (version < 4) data = { ...data, schemaVersion: 4, subtitles: [] } // v3 -> v4: subtitles; clip/track volume and fades default in
  if (version < 5) data = { ...data, schemaVersion: 5 } // v4 -> v5: picture fades default to 0
  if (version < 6) data = { ...data, schemaVersion: 6 } // v5 -> v6: optional clip effects
  return repairProject(ProjectSchema.parse({ ...data, schemaVersion: CURRENT_SCHEMA_VERSION }))
}

/** Drop clips that point at a track or media item that no longer exists, so a project always opens. */
export function repairProject(p: Project): Project {
  const tracks = new Set(p.tracks.map((t) => t.id))
  const assets = new Set(p.media.map((a) => a.id))
  const subtitleTracks = new Set(p.tracks.filter((t) => t.kind === 'subtitle').map((t) => t.id))
  const clips = p.clips.filter((c) => tracks.has(c.trackId) && assets.has(c.assetId))
  const subtitles = p.subtitles.filter((c) => subtitleTracks.has(c.trackId))
  return clips.length === p.clips.length && subtitles.length === p.subtitles.length ? p : { ...p, clips, subtitles }
}
