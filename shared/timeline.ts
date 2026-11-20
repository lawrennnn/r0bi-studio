import type { Clip, MediaAsset, MediaKind, Project, SubtitleCue, TrackKind } from './project'
import { effectsOf, splitEffects } from './effects'

/** Pure timeline math. Everything is integer frames at the project frame rate. */

export const DEFAULT_IMAGE_SECONDS = 5

export const clipEnd = (c: Pick<Clip, 'startFrame' | 'durationFrames'>): number => c.startFrame + c.durationFrames

/** Keep fades inside the clip: fade in first, fade out gets what is left. */
export function normalizeFades(c: Clip): Clip {
  const fadeIn = Math.min(c.fadeInFrames, c.durationFrames)
  const fadeOut = Math.min(c.fadeOutFrames, c.durationFrames - fadeIn)
  const vIn = Math.min(c.videoFadeInFrames, c.durationFrames)
  const vOut = Math.min(c.videoFadeOutFrames, c.durationFrames - vIn)
  return fadeIn === c.fadeInFrames && fadeOut === c.fadeOutFrames && vIn === c.videoFadeInFrames && vOut === c.videoFadeOutFrames
    ? c
    : { ...c, fadeInFrames: fadeIn, fadeOutFrames: fadeOut, videoFadeInFrames: vIn, videoFadeOutFrames: vOut }
}

export function canPlace(track: TrackKind, asset: MediaKind): boolean {
  if (track === 'video' || track === 'overlay') return asset === 'video' || asset === 'image'
  if (track === 'audio') return asset === 'audio'
  return false // subtitle clips arrive with the subtitle studio
}

/** Frames of source available (floored so a clip never runs past the file); null = unlimited (stills). */
export function assetFrames(asset: Pick<MediaAsset, 'kind' | 'durationMs'>, fps: number): number | null {
  if (asset.kind === 'image') return null
  return Math.max(1, Math.floor((asset.durationMs * fps) / 1000))
}

export function defaultClipFrames(asset: Pick<MediaAsset, 'kind' | 'durationMs'>, fps: number): number {
  return assetFrames(asset, fps) ?? DEFAULT_IMAGE_SECONDS * fps
}

export function clipsOnTrack(clips: readonly Clip[], trackId: string, ignoreId?: string | null): Clip[] {
  return clips.filter((c) => c.trackId === trackId && c.id !== ignoreId).sort((a, b) => a.startFrame - b.startFrame)
}

/** Nearest start frame to `desired` where a clip of `duration` fits without overlapping. */
export function findFreeStart(clips: readonly Clip[], trackId: string, duration: number, desired: number, ignoreId?: string | null): number {
  const others = clipsOnTrack(clips, trackId, ignoreId)
  const fits = (s: number) => s >= 0 && others.every((o) => !(s < clipEnd(o) && o.startFrame < s + duration))
  const want = Math.max(0, Math.round(desired))
  if (fits(want)) return want
  const candidates = [0]
  for (const o of others) candidates.push(clipEnd(o), o.startFrame - duration)
  return candidates.filter(fits).sort((a, b) => Math.abs(a - want) - Math.abs(b - want) || a - b)[0]
}

export function snapPoints(clips: readonly Clip[], ignoreId: string | null, playhead: number): number[] {
  const pts = new Set<number>([0, playhead])
  for (const c of clips) {
    if (c.id === ignoreId) continue
    pts.add(c.startFrame)
    pts.add(clipEnd(c))
  }
  return [...pts]
}

/** Snap a clip's start or end to the nearest point within `threshold` frames. */
export function snapStart(start: number, duration: number, points: readonly number[], threshold: number): { start: number; snapped: number | null } {
  let best: { start: number; snapped: number | null } = { start, snapped: null }
  let bestDist = threshold + 1
  for (const p of points) {
    const dStart = Math.abs(p - start)
    if (dStart <= threshold && dStart < bestDist) {
      bestDist = dStart
      best = { start: p, snapped: p }
    }
    const dEnd = Math.abs(p - (start + duration))
    if (dEnd <= threshold && dEnd < bestDist && p - duration >= 0) {
      bestDist = dEnd
      best = { start: p - duration, snapped: p }
    }
  }
  return best
}

export function snapEdge(frame: number, points: readonly number[], threshold: number): { frame: number; snapped: number | null } {
  let best: { frame: number; snapped: number | null } = { frame, snapped: null }
  let bestDist = threshold + 1
  for (const p of points) {
    const d = Math.abs(p - frame)
    if (d <= threshold && d < bestDist) {
      bestDist = d
      best = { frame: p, snapped: p }
    }
  }
  return best
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/** Move a clip's left edge. Stays inside the source, off neighbours, and at least 1 frame long. */
export function trimLeft(clip: Clip, newStart: number, clips: readonly Clip[], asset: Pick<MediaAsset, 'kind'> | undefined): Clip {
  const isImage = asset?.kind === 'image'
  const prevEnd = Math.max(0, ...clipsOnTrack(clips, clip.trackId, clip.id).filter((c) => clipEnd(c) <= clip.startFrame).map(clipEnd))
  const minStart = isImage ? prevEnd : Math.max(prevEnd, clip.startFrame - clip.sourceInFrame)
  const s = clamp(Math.round(newStart), minStart, clipEnd(clip) - 1)
  const delta = s - clip.startFrame
  return normalizeFades({
    ...clip,
    startFrame: s,
    sourceInFrame: isImage ? 0 : clip.sourceInFrame + delta,
    durationFrames: clip.durationFrames - delta
  })
}

/** Move a clip's right edge. Cannot pass the source end or the next clip. */
export function trimRight(
  clip: Clip,
  newEnd: number,
  clips: readonly Clip[],
  asset: Pick<MediaAsset, 'kind' | 'durationMs'> | undefined,
  fps: number
): Clip {
  const others = clipsOnTrack(clips, clip.trackId, clip.id).filter((c) => c.startFrame >= clipEnd(clip))
  const nextStart = others.length ? others[0].startFrame : Infinity
  const frames = asset ? assetFrames(asset, fps) : null
  const sourceEnd = frames === null ? Infinity : clip.startFrame + (frames - clip.sourceInFrame)
  const maxEnd = Math.max(clip.startFrame + 1, Math.min(nextStart, sourceEnd))
  const end = clamp(Math.round(newEnd), clip.startFrame + 1, maxEnd)
  return normalizeFades({ ...clip, durationFrames: end - clip.startFrame })
}

/** Split at `frame` (strictly inside the clip). Returns [left, right] or null. */
export function splitClip(clip: Clip, frame: number, newId: string, isImage: boolean): [Clip, Clip] | null {
  if (frame <= clip.startFrame || frame >= clipEnd(clip)) return null
  const leftLen = frame - clip.startFrame
  // The fade-in stays with the left half and the fade-out with the right half.
  const [leftFx, rightFx] = clip.effects ? splitEffects(effectsOf(clip), clip.durationFrames, leftLen) : [undefined, undefined]
  const withFx = (c: Clip, fx: Clip['effects']): Clip => {
    const { effects: _drop, ...rest } = c
    void _drop
    return fx ? { ...rest, effects: fx } : rest
  }
  return [
    withFx(normalizeFades({ ...clip, durationFrames: leftLen, fadeOutFrames: 0, videoFadeOutFrames: 0 }), leftFx),
    withFx(normalizeFades({
      ...clip,
      id: newId,
      startFrame: frame,
      sourceInFrame: isImage ? 0 : clip.sourceInFrame + leftLen,
      durationFrames: clipEnd(clip) - frame,
      fadeInFrames: 0,
      videoFadeInFrames: 0
    }), rightFx)
  ]
}

/** Keep clips inside their source after the asset changed (relink) or the frame rate changed. */
export function clampClipsToAsset(clips: readonly Clip[], asset: Pick<MediaAsset, 'id' | 'kind' | 'durationMs'>, fps: number): Clip[] {
  const frames = assetFrames(asset, fps)
  if (frames === null) return clips.map((c) => c)
  return clips.map((c) => {
    if (c.assetId !== asset.id) return c
    const sourceIn = Math.min(c.sourceInFrame, frames - 1)
    return normalizeFades({ ...c, sourceInFrame: sourceIn, durationFrames: Math.max(1, Math.min(c.durationFrames, frames - sourceIn)) })
  })
}

/** Convert all clip times to a new frame rate, keeping adjacent clips adjacent and never overlapping. */
export function rescaleClips(clips: readonly Clip[], media: readonly MediaAsset[], oldFps: number, newFps: number): Clip[] {
  if (oldFps === newFps) return clips.map((c) => c)
  const k = newFps / oldFps
  const assets = new Map(media.map((a) => [a.id, a]))
  const scaled = clips.map((c) => {
    const start = Math.round(c.startFrame * k)
    const end = Math.max(start + 1, Math.round(clipEnd(c) * k))
    return normalizeFades({
      ...c,
      startFrame: start,
      sourceInFrame: Math.round(c.sourceInFrame * k),
      durationFrames: end - start,
      fadeInFrames: Math.round(c.fadeInFrames * k),
      fadeOutFrames: Math.round(c.fadeOutFrames * k),
      videoFadeInFrames: Math.round(c.videoFadeInFrames * k),
      videoFadeOutFrames: Math.round(c.videoFadeOutFrames * k)
    })
  })
  const bounded = scaled.map((c) => {
    const asset = assets.get(c.assetId)
    return asset ? (clampClipsToAsset([c], asset, newFps)[0] ?? c) : c
  })
  // Rounding can leave a 1-frame overlap; push later clips right.
  const byTrack = new Map<string, Clip[]>()
  for (const c of bounded) byTrack.set(c.trackId, [...(byTrack.get(c.trackId) ?? []), c])
  const fixed = new Map<string, Clip>()
  for (const list of byTrack.values()) {
    let edge = 0
    for (const c of list.sort((a, b) => a.startFrame - b.startFrame)) {
      const start = Math.max(c.startFrame, edge)
      fixed.set(c.id, { ...c, startFrame: start })
      edge = start + c.durationFrames
    }
  }
  return bounded.map((c) => fixed.get(c.id) ?? c)
}

/** Every rule a valid timeline must satisfy. Empty array means valid. */
export function validateClips(p: Pick<Project, 'clips' | 'tracks' | 'media' | 'settings'>): string[] {
  const issues: string[] = []
  const tracks = new Map(p.tracks.map((t) => [t.id, t]))
  const assets = new Map(p.media.map((a) => [a.id, a]))
  for (const c of p.clips) {
    const track = tracks.get(c.trackId)
    const asset = assets.get(c.assetId)
    if (!track) issues.push(`clip ${c.id}: unknown track`)
    if (!asset) issues.push(`clip ${c.id}: unknown asset`)
    if (c.durationFrames < 1 || c.startFrame < 0 || c.sourceInFrame < 0) issues.push(`clip ${c.id}: negative or empty range`)
    if (c.fadeInFrames + c.fadeOutFrames > c.durationFrames || c.videoFadeInFrames + c.videoFadeOutFrames > c.durationFrames) issues.push(`clip ${c.id}: fades longer than the clip`)
    if (track && asset && !canPlace(track.kind, asset.kind)) issues.push(`clip ${c.id}: ${asset.kind} on ${track.kind} track`)
    if (asset) {
      const frames = assetFrames(asset, p.settings.fps)
      if (frames !== null && c.sourceInFrame + c.durationFrames > frames) issues.push(`clip ${c.id}: runs past end of source`)
    }
  }
  for (const t of p.tracks) {
    const list = clipsOnTrack(p.clips, t.id)
    for (let i = 1; i < list.length; i++) {
      if (list[i].startFrame < clipEnd(list[i - 1])) issues.push(`track ${t.name}: clips overlap`)
    }
  }
  return issues
}

/** Frame after the last clip or subtitle: where playback stops. 0 when the timeline is empty. */
export function timelineEnd(p: { clips: readonly Clip[]; subtitles?: readonly SubtitleCue[] }): number {
  const clips = p.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0)
  return (p.subtitles ?? []).reduce((m, c) => Math.max(m, clipEnd(c)), clips)
}

/**
 * Subtitle cues behave like unlimited stills (free to extend either way, never overlapping),
 * so the clip helpers above can move and trim them too.
 */
export const cueAsClip = (c: SubtitleCue): Clip => ({
  id: c.id, trackId: c.trackId, assetId: '', startFrame: c.startFrame, sourceInFrame: 0,
  durationFrames: c.durationFrames, volume: 100, fadeInFrames: 0, fadeOutFrames: 0, videoFadeInFrames: 0, videoFadeOutFrames: 0
})
export const clipAsCue = (clip: Clip, text: string): SubtitleCue => ({
  id: clip.id, trackId: clip.trackId, startFrame: clip.startFrame, durationFrames: clip.durationFrames, text
})
export const CUE_ASSET = { kind: 'image' as const, durationMs: 0 }

export function rescaleCues(cues: readonly SubtitleCue[], oldFps: number, newFps: number): SubtitleCue[] {
  const text = new Map(cues.map((c) => [c.id, c.text]))
  return rescaleClips(cues.map(cueAsClip), [], oldFps, newFps).map((c) => clipAsCue(c, text.get(c.id) ?? ''))
}

export function validateSubtitles(p: Pick<Project, 'subtitles' | 'tracks'>): string[] {
  const issues: string[] = []
  const tracks = new Map(p.tracks.map((t) => [t.id, t]))
  for (const c of p.subtitles) {
    const t = tracks.get(c.trackId)
    if (!t || t.kind !== 'subtitle') issues.push(`cue ${c.id}: not on a subtitle track`)
    if (c.startFrame < 0 || c.durationFrames < 1) issues.push(`cue ${c.id}: negative or empty range`)
  }
  for (const t of p.tracks.filter((x) => x.kind === 'subtitle')) {
    const list = p.subtitles.filter((c) => c.trackId === t.id).sort((a, b) => a.startFrame - b.startFrame)
    for (let i = 1; i < list.length; i++) {
      if (list[i].startFrame < clipEnd(list[i - 1])) issues.push(`track ${t.name}: cues overlap`)
    }
  }
  return issues
}

// ---- Scene manager helpers (a "scene" is a clip on the chosen video track) ---------------------

/** Move one scene to a new position in the order. Scenes keep their lengths and the gaps between slots, so the group fills the same span. */
export function reorderOnTrack(clips: readonly Clip[], trackId: string, from: number, to: number): Clip[] | null {
  const list = clipsOnTrack(clips, trackId)
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return null
  const gaps = list.slice(1).map((c, i) => c.startFrame - clipEnd(list[i]))
  const order = [...list]
  const [moved] = order.splice(from, 1)
  order.splice(to, 0, moved)
  const placed = new Map<string, number>()
  let t = list[0].startFrame
  order.forEach((c, i) => {
    placed.set(c.id, t)
    t += c.durationFrames + (gaps[i] ?? 0)
  })
  return clips.map((c) => (placed.has(c.id) ? { ...c, startFrame: placed.get(c.id) as number } : c))
}

/** Pack the scenes on a track back to back, starting where the first one starts. */
export function closeGapsOnTrack(clips: readonly Clip[], trackId: string): Clip[] {
  const list = clipsOnTrack(clips, trackId)
  const placed = new Map<string, number>()
  let t = list[0]?.startFrame ?? 0
  for (const c of list) {
    placed.set(c.id, t)
    t += c.durationFrames
  }
  return clips.map((c) => (placed.has(c.id) ? { ...c, startFrame: placed.get(c.id) as number } : c))
}

/** Remove a scene and pull the later scenes on its track left to fill the gap. */
export function rippleDeleteOnTrack(clips: readonly Clip[], id: string): Clip[] {
  const gone = clips.find((c) => c.id === id)
  if (!gone) return clips.map((c) => c)
  return clips.filter((c) => c.id !== id).map((c) => (c.trackId === gone.trackId && c.startFrame >= clipEnd(gone) ? { ...c, startFrame: c.startFrame - gone.durationFrames } : c))
}
