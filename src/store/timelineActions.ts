import { ClipEffectsSchema, DEFAULT_EFFECTS, makeTrack, type Clip, type ClipEffects } from '@shared/project'
import { compactEffects, EFFECT_PRESETS, effectsOf } from '@shared/effects'
import { rescaleCues } from '@shared/timeline'
import {
  canPlace, clipEnd, clipsOnTrack, closeGapsOnTrack, normalizeFades, reorderOnTrack, rippleDeleteOnTrack, defaultClipFrames, findFreeStart, rescaleClips, splitClip, trimRight, validateClips, assetFrames
} from '@shared/timeline'
import { useProjectStore } from './projectStore'
import { useUiStore } from './uiStore'

const project = () => useProjectStore.getState().project
const commit = (fn: Parameters<ReturnType<typeof useProjectStore.getState>['commit']>[0], key?: string) => useProjectStore.getState().commit(fn, key)
const select = (id: string | null) => useUiStore.getState().patch({ selectedClipId: id, selectedCueId: null })

/**
 * All timeline edits. Each one is a single undo step and re-checks the timeline rules,
 * so no combination of edits can produce overlapping or out-of-range clips.
 */
export const timeline = {
  /** Put a library item on a specific track at (or near) a frame. Returns the new clip id. */
  addAsset(assetId: string, trackId: string, desiredStart: number): string | null {
    const p = project()
    const asset = p?.media.find((a) => a.id === assetId)
    const track = p?.tracks.find((t) => t.id === trackId)
    if (!p || !asset || !track || track.locked || !canPlace(track.kind, asset.kind)) return null
    const durationFrames = defaultClipFrames(asset, p.settings.fps)
    const clip: Clip = {
      id: crypto.randomUUID(),
      trackId,
      assetId,
      startFrame: findFreeStart(p.clips, trackId, durationFrames, desiredStart),
      sourceInFrame: 0,
      durationFrames,
      volume: 100,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      videoFadeInFrames: 0,
      videoFadeOutFrames: 0
    }
    commit((d) => void d.clips.push(clip))
    select(clip.id)
    return clip.id
  },

  /** Add at the playhead on the first track that accepts this kind of media. */
  addAssetAuto(assetId: string): string | null {
    const p = project()
    const asset = p?.media.find((a) => a.id === assetId)
    if (!p || !asset) return null
    const track = p.tracks.find((t) => !t.locked && canPlace(t.kind, asset.kind))
    return track ? timeline.addAsset(assetId, track.id, useUiStore.getState().playhead) : null
  },

  /** Replace one clip (used by drag, trim and the properties panel). Rejects anything invalid. */
  replaceClip(next: Clip): boolean {
    const p = project()
    const old = p?.clips.find((c) => c.id === next.id)
    if (!p || !old) return false
    const track = p.tracks.find((t) => t.id === next.trackId)
    const oldTrack = p.tracks.find((t) => t.id === old.trackId)
    if (!track || track.locked || oldTrack?.locked) return false
    const clips = p.clips.map((c) => (c.id === next.id ? next : c))
    if (validateClips({ ...p, clips }).length > 0) return false
    commit((d) => {
      const i = d.clips.findIndex((c) => c.id === next.id)
      if (i >= 0) d.clips[i] = next
    })
    return true
  },

  setStart(id: string, start: number): boolean {
    const p = project()
    const c = p?.clips.find((x) => x.id === id)
    if (!p || !c) return false
    return timeline.replaceClip({ ...c, startFrame: findFreeStart(p.clips, c.trackId, c.durationFrames, start, c.id) })
  },

  setDuration(id: string, duration: number): boolean {
    const p = project()
    const c = p?.clips.find((x) => x.id === id)
    if (!p || !c) return false
    const asset = p.media.find((a) => a.id === c.assetId)
    return timeline.replaceClip(trimRight(c, c.startFrame + duration, p.clips, asset, p.settings.fps))
  },

  setSourceIn(id: string, sourceIn: number): boolean {
    const p = project()
    const c = p?.clips.find((x) => x.id === id)
    const asset = p?.media.find((a) => a.id === c?.assetId)
    if (!p || !c || !asset) return false
    const frames = assetFrames(asset, p.settings.fps)
    if (frames === null) return false
    return timeline.replaceClip({ ...c, sourceInFrame: Math.min(Math.max(0, Math.round(sourceIn)), frames - c.durationFrames) })
  },

  /**
   * Split at a frame (default: playhead). With a selection, splits the selected clip;
   * otherwise every unlocked clip under the frame. Returns how many clips were split.
   */
  split(frame?: number): number {
    const p = project()
    if (!p) return 0
    const at = frame ?? useUiStore.getState().playhead
    const selected = useUiStore.getState().selectedClipId
    const lockedTracks = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id))
    const pool = selected && p.clips.some((c) => c.id === selected) ? p.clips.filter((c) => c.id === selected) : p.clips
    const plans: { left: Clip; right: Clip }[] = []
    for (const c of pool) {
      if (lockedTracks.has(c.trackId)) continue
      const isImage = p.media.find((a) => a.id === c.assetId)?.kind === 'image'
      const parts = splitClip(c, at, crypto.randomUUID(), isImage)
      if (parts) plans.push({ left: parts[0], right: parts[1] })
    }
    if (plans.length === 0) return 0
    commit((d) => {
      for (const { left, right } of plans) {
        const i = d.clips.findIndex((c) => c.id === left.id)
        if (i >= 0) d.clips.splice(i, 1, left, right)
      }
    })
    select(plans[plans.length - 1].right.id)
    return plans.length
  },

  remove(id: string): boolean {
    const p = project()
    const c = p?.clips.find((x) => x.id === id)
    if (!p || !c || p.tracks.find((t) => t.id === c.trackId)?.locked) return false
    commit((d) => void (d.clips = d.clips.filter((x) => x.id !== id)))
    if (useUiStore.getState().selectedClipId === id) select(null)
    return true
  },

  /** Copy a clip to the nearest free space after the original. */
  duplicate(id: string): string | null {
    const p = project()
    const c = p?.clips.find((x) => x.id === id)
    if (!p || !c || p.tracks.find((t) => t.id === c.trackId)?.locked) return null
    const copy: Clip = { ...c, id: crypto.randomUUID(), startFrame: findFreeStart(p.clips, c.trackId, c.durationFrames, clipEnd(c)) }
    commit((d) => void d.clips.push(copy))
    select(copy.id)
    return copy.id
  },

  /** Change the project frame rate, converting every clip (and the playhead) to the new rate. */
  setFps(fps: number): void {
    const p = project()
    if (!p || p.settings.fps === fps) return
    const old = p.settings.fps
    commit((d) => {
      d.clips = rescaleClips(d.clips, d.media, old, fps)
      d.subtitles = rescaleCues(d.subtitles, old, fps)
      d.settings.fps = fps
    })
    const ui = useUiStore.getState()
    ui.patch({ playhead: Math.round((ui.playhead * fps) / old) })
  },

  /** Clip level, 0-100. Rapid changes (a slider drag) merge into one undo step. */
  setVolume(id: string, volume: number): boolean {
    const c = project()?.clips.find((x) => x.id === id)
    if (!c || project()?.tracks.find((t) => t.id === c.trackId)?.locked) return false
    const v = Math.min(100, Math.max(0, Math.round(volume)))
    if (v === c.volume) return true
    commit((d) => void (d.clips.find((x) => x.id === id)!.volume = v), `vol:${id}`)
    return true
  },

  /** Fade length in frames; a fade can never push the other fade out of the clip. */
  setFade(id: string, which: 'in' | 'out', frames: number): boolean {
    const c = project()?.clips.find((x) => x.id === id)
    if (!c || project()?.tracks.find((t) => t.id === c.trackId)?.locked) return false
    const other = which === 'in' ? c.fadeOutFrames : c.fadeInFrames
    const f = Math.min(Math.max(0, Math.round(frames)), c.durationFrames - other)
    const key = which === 'in' ? 'fadeInFrames' : 'fadeOutFrames'
    if (f === c[key]) return true
    commit((d) => void (d.clips.find((x) => x.id === id)![key] = f), `fade:${id}:${which}`)
    return true
  },

  /** Picture fade length in frames (from/to black, or a dissolve over whatever is below). */
  setVideoFade(id: string, which: 'in' | 'out', frames: number): boolean {
    const p = project()
    const c = p?.clips.find((x) => x.id === id)
    const asset = p?.media.find((a) => a.id === c?.assetId)
    const track = p?.tracks.find((t) => t.id === c?.trackId)
    if (!p || !c || !asset || !track || track.locked || asset.kind === 'audio' || track.kind === 'audio') return false
    const other = which === 'in' ? c.videoFadeOutFrames : c.videoFadeInFrames
    const f = Math.min(Math.max(0, Math.round(frames)), c.durationFrames - other)
    const key = which === 'in' ? 'videoFadeInFrames' : 'videoFadeOutFrames'
    if (f === c[key]) return true
    commit((d) => void (d.clips.find((x) => x.id === id)![key] = f), `vfade:${id}:${which}`)
    return true
  },

  /** Fade clip A out and clip B in over the same length: a dip to black across a cut. One undo step. */
  dipToBlack(aId: string, bId: string, frames: number): boolean {
    const p = project()
    const a = p?.clips.find((x) => x.id === aId)
    const b = p?.clips.find((x) => x.id === bId)
    if (!p || !a || !b || a.trackId !== b.trackId || b.startFrame < a.startFrame + a.durationFrames) return false
    const track = p.tracks.find((t) => t.id === a.trackId)
    if (!track || track.locked || track.kind === 'audio') return false
    const n = Math.max(1, Math.round(frames))
    commit((d) => {
      const da = d.clips.find((x) => x.id === aId)!
      const db = d.clips.find((x) => x.id === bId)!
      da.videoFadeOutFrames = Math.min(n, da.durationFrames - da.videoFadeInFrames)
      db.videoFadeInFrames = Math.min(n, db.durationFrames - db.videoFadeOutFrames)
    })
    return true
  },

  /** Opacity, zoom and position animation. Slider drags merge into one undo step. */
  setEffects(id: string, patch: Partial<ClipEffects>): boolean {
    const p = project()
    const c = p?.clips.find((x) => x.id === id)
    const asset = p?.media.find((a) => a.id === c?.assetId)
    const track = p?.tracks.find((t) => t.id === c?.trackId)
    if (!p || !c || !asset || !track || track.locked || asset.kind === 'audio' || track.kind === 'audio') return false
    const next = ClipEffectsSchema.safeParse({ ...effectsOf(c), ...patch })
    if (!next.success) return false
    const compact = compactEffects(next.data)
    if (JSON.stringify(compact) === JSON.stringify(c.effects)) return true
    commit((d) => {
      const x = d.clips.find((y) => y.id === id)!
      if (compact) x.effects = compact
      else delete x.effects
    }, `fx:${id}`)
    return true
  },

  /** One-click move such as a slow zoom or a pan. Keeps the clip's opacity. */
  applyEffectPreset(id: string, presetId: string): boolean {
    const c = project()?.clips.find((x) => x.id === id)
    const preset = EFFECT_PRESETS.find((x) => x.id === presetId)
    if (!c || !preset) return false
    return timeline.setEffects(id, { ...DEFAULT_EFFECTS, opacity: effectsOf(c).opacity, ...preset.effects })
  },

  resetEffects(id: string): boolean {
    return timeline.setEffects(id, DEFAULT_EFFECTS)
  },

  /**
   * Dissolve from a clip into the one that follows it on the same track. The next clip moves up to
   * the nearest free video track and starts a little early (using its own lead-in footage), fading in
   * over the end of the first clip, so nothing after it shifts. One undo step.
   */
  dissolveIntoNext(id: string, frames: number): { ok: true } | { ok: false; error: string } {
    const p = project()
    const a = p?.clips.find((x) => x.id === id)
    if (!p || !a) return { ok: false, error: 'Select a clip first' }
    const trackIdx = p.tracks.findIndex((t) => t.id === a.trackId)
    const track = p.tracks[trackIdx]
    if (!track || track.locked || (track.kind !== 'video' && track.kind !== 'overlay')) return { ok: false, error: 'This only works for clips on a video track' }
    const b = clipsOnTrack(p.clips, a.trackId, a.id).find((c) => c.startFrame >= clipEnd(a))
    if (!b || b.startFrame !== clipEnd(a)) return { ok: false, error: 'There is no clip directly after this one on the same track' }
    const assetB = p.media.find((m) => m.id === b.assetId)
    const assetA = p.media.find((m) => m.id === a.assetId)
    if (!assetA || !assetB || assetA.kind === 'audio' || assetB.kind === 'audio') return { ok: false, error: 'Both clips need a picture' }
    const d = Math.max(1, Math.min(Math.round(frames), a.durationFrames))
    const isImage = assetB.kind === 'image'
    if (!isImage && b.sourceInFrame < d) {
      return { ok: false, error: `The next clip has only ${(b.sourceInFrame / p.settings.fps).toFixed(2)} s of footage before its start, not enough for a ${(d / p.settings.fps).toFixed(2)} s dissolve. Use a shorter dissolve or Dip to black` }
    }
    const grown = { start: b.startFrame - d, end: clipEnd(b) }
    const free = (t: { id: string; locked: boolean }) => !t.locked && p.clips.every((c) => c.trackId !== t.id || c.id === b.id || !(grown.start < clipEnd(c) && c.startFrame < grown.end))
    const tracks = p.tracks.map((t) => ({ ...t }))
    let upper = [...tracks.slice(0, trackIdx)].reverse().find((t) => t.kind === 'video' && free(t))
    if (!upper) {
      upper = makeTrack('video', tracks)
      tracks.splice(trackIdx, 0, upper) // directly above the first clip's track
    }
    const moved: Clip = normalizeFades({
      ...b, trackId: upper.id, startFrame: grown.start, sourceInFrame: isImage ? 0 : b.sourceInFrame - d, durationFrames: b.durationFrames + d,
      videoFadeInFrames: d, fadeInFrames: Math.max(b.fadeInFrames, d)
    })
    const first: Clip = normalizeFades({ ...a, fadeOutFrames: Math.max(a.fadeOutFrames, Math.min(d, a.durationFrames)) })
    const clips = p.clips.map((c) => (c.id === b.id ? moved : c.id === a.id ? first : c))
    const issues = validateClips({ ...p, tracks, clips })
    if (issues.length > 0) return { ok: false, error: `That would break a timeline rule (${issues[0]})` }
    commit((draft) => {
      draft.tracks = tracks
      draft.clips = clips
    })
    select(moved.id)
    return { ok: true }
  },

  /** A short note on a clip (shown in the Scenes panel). Typing merges into one undo step. */
  setNote(id: string, note: string): boolean {
    const c = project()?.clips.find((x) => x.id === id)
    if (!c || note.length > 500) return false
    if ((c.note ?? '') === note) return true
    commit((d) => {
      const x = d.clips.find((y) => y.id === id)!
      if (note) x.note = note
      else delete x.note
    }, `note:${id}`)
    return true
  },

  /** Move a scene to another place in the order on its track (neighbours swap lengths and gaps correctly). */
  reorderScene(trackId: string, from: number, to: number): boolean {
    const p = project()
    const track = p?.tracks.find((t) => t.id === trackId)
    if (!p || !track || track.locked) return false
    const clips = reorderOnTrack(p.clips, trackId, from, to)
    if (!clips || validateClips({ ...p, clips }).length > 0) return false
    commit((d) => void (d.clips = clips))
    return true
  },

  /** Delete a scene and close the gap it leaves. */
  rippleDelete(id: string): boolean {
    const p = project()
    const c = p?.clips.find((x) => x.id === id)
    if (!p || !c || p.tracks.find((t) => t.id === c.trackId)?.locked) return false
    const clips = rippleDeleteOnTrack(p.clips, id)
    if (validateClips({ ...p, clips }).length > 0) return false
    commit((d) => void (d.clips = clips))
    if (useUiStore.getState().selectedClipId === id) select(null)
    return true
  },

  /** Pack the scenes on a track back to back. */
  closeGaps(trackId: string): boolean {
    const p = project()
    const track = p?.tracks.find((t) => t.id === trackId)
    if (!p || !track || track.locked) return false
    const clips = closeGapsOnTrack(p.clips, trackId)
    if (JSON.stringify(clips) === JSON.stringify(p.clips) || validateClips({ ...p, clips }).length > 0) return false
    commit((d) => void (d.clips = clips))
    return true
  },

  /** Track level for the mix, 0-100. */
  setTrackVolume(trackId: string, volume: number): void {
    const t = project()?.tracks.find((x) => x.id === trackId)
    const v = Math.min(100, Math.max(0, Math.round(volume)))
    if (!t || t.volume === v) return
    commit((d) => void (d.tracks.find((x) => x.id === trackId)!.volume = v), `tvol:${trackId}`)
  },

  /** Sync helpers: shift a clip by some frames (never into a neighbour) or start it at the playhead. */
  nudge(id: string, deltaFrames: number): boolean {
    const c = project()?.clips.find((x) => x.id === id)
    return c ? timeline.setStart(id, Math.max(0, c.startFrame + deltaFrames)) : false
  },
  startAtPlayhead(id: string): boolean {
    return timeline.setStart(id, useUiStore.getState().playhead)
  },

  /** Clips on a track, sorted, for neighbours/UI. */
  clipsOn: (trackId: string): Clip[] => clipsOnTrack(project()?.clips ?? [], trackId)
}
