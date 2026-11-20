import { SubtitleStyleSchema, DEFAULT_SUBTITLE_STYLE, type SubtitleCue, type SubtitleStyle } from '@shared/project'
import { clipEnd, cueAsClip, findFreeStart, validateSubtitles } from '@shared/timeline'
import { useProjectStore } from './projectStore'
import { useUiStore } from './uiStore'

const project = () => useProjectStore.getState().project
const commit = (fn: Parameters<ReturnType<typeof useProjectStore.getState>['commit']>[0], key?: string) => useProjectStore.getState().commit(fn, key)
const select = (id: string | null) => useUiStore.getState().patch({ selectedCueId: id, selectedClipId: null })
const cueClips = (cues: readonly SubtitleCue[]) => cues.map(cueAsClip)

export const subtitleStyleOf = (track: { subtitleStyle?: SubtitleStyle } | undefined): SubtitleStyle => track?.subtitleStyle ?? DEFAULT_SUBTITLE_STYLE

/** All subtitle edits. Each is one undo step and keeps cues from overlapping on their track. */
export const subtitles = {
  addCue(trackId: string, atFrame?: number, text = 'Subtitle'): string | null {
    const p = project()
    const track = p?.tracks.find((t) => t.id === trackId)
    if (!p || !track || track.kind !== 'subtitle' || track.locked) return null
    const durationFrames = Math.max(1, p.settings.fps * 2)
    const cue: SubtitleCue = {
      id: crypto.randomUUID(),
      trackId,
      startFrame: findFreeStart(cueClips(p.subtitles), trackId, durationFrames, atFrame ?? useUiStore.getState().playhead),
      durationFrames,
      text
    }
    commit((d) => void d.subtitles.push(cue))
    select(cue.id)
    return cue.id
  },

  setText(id: string, text: string): boolean {
    const p = project()
    const cue = p?.subtitles.find((c) => c.id === id)
    if (!p || !cue || p.tracks.find((t) => t.id === cue.trackId)?.locked || text.length > 2000) return false
    if (cue.text === text) return true
    commit((d) => void (d.subtitles.find((c) => c.id === id)!.text = text), `cue-text:${id}`)
    return true
  },

  /** Replace one cue (drag, trim, properties). Rejects overlaps and locked tracks. */
  replaceCue(next: SubtitleCue): boolean {
    const p = project()
    const old = p?.subtitles.find((c) => c.id === next.id)
    if (!p || !old) return false
    const target = p.tracks.find((t) => t.id === next.trackId)
    if (!target || target.kind !== 'subtitle' || target.locked || p.tracks.find((t) => t.id === old.trackId)?.locked) return false
    const list = p.subtitles.map((c) => (c.id === next.id ? next : c))
    if (validateSubtitles({ tracks: p.tracks, subtitles: list }).length > 0) return false
    commit((d) => {
      const i = d.subtitles.findIndex((c) => c.id === next.id)
      if (i >= 0) d.subtitles[i] = next
    })
    return true
  },

  setStart(id: string, start: number): boolean {
    const p = project()
    const cue = p?.subtitles.find((c) => c.id === id)
    if (!p || !cue) return false
    const startFrame = findFreeStart(cueClips(p.subtitles), cue.trackId, cue.durationFrames, start, id)
    return subtitles.replaceCue({ ...cue, startFrame })
  },

  setDuration(id: string, duration: number): boolean {
    const p = project()
    const cue = p?.subtitles.find((c) => c.id === id)
    if (!p || !cue) return false
    const next = p.subtitles.filter((c) => c.trackId === cue.trackId && c.id !== id && c.startFrame >= clipEnd(cue)).sort((a, b) => a.startFrame - b.startFrame)[0]
    const maxEnd = next ? next.startFrame : Infinity
    const end = Math.min(maxEnd, cue.startFrame + Math.max(1, Math.round(duration)))
    return subtitles.replaceCue({ ...cue, durationFrames: end - cue.startFrame })
  },

  nudge(id: string, delta: number): boolean {
    const cue = project()?.subtitles.find((c) => c.id === id)
    return cue ? subtitles.setStart(id, Math.max(0, cue.startFrame + delta)) : false
  },

  startAtPlayhead(id: string): boolean {
    return subtitles.setStart(id, useUiStore.getState().playhead)
  },

  remove(id: string): boolean {
    const p = project()
    const cue = p?.subtitles.find((c) => c.id === id)
    if (!p || !cue || p.tracks.find((t) => t.id === cue.trackId)?.locked) return false
    commit((d) => void (d.subtitles = d.subtitles.filter((c) => c.id !== id)))
    if (useUiStore.getState().selectedCueId === id) select(null)
    return true
  },

  duplicate(id: string): string | null {
    const p = project()
    const cue = p?.subtitles.find((c) => c.id === id)
    if (!p || !cue || p.tracks.find((t) => t.id === cue.trackId)?.locked) return null
    const copy: SubtitleCue = { ...cue, id: crypto.randomUUID(), startFrame: findFreeStart(cueClips(p.subtitles), cue.trackId, cue.durationFrames, clipEnd(cue)) }
    commit((d) => void d.subtitles.push(copy))
    select(copy.id)
    return copy.id
  },

  /** Add imported cues to a track in one step. Cues that would overlap existing ones are skipped. */
  importCues(trackId: string, cues: { startFrame: number; durationFrames: number; text: string }[]): { added: number; skipped: number } {
    const p = project()
    const track = p?.tracks.find((t) => t.id === trackId)
    if (!p || !track || track.kind !== 'subtitle' || track.locked) return { added: 0, skipped: cues.length }
    const existing = cueClips(p.subtitles.filter((c) => c.trackId === trackId))
    const fresh: SubtitleCue[] = []
    let skipped = 0
    for (const c of cues) {
      const clash = [...existing, ...fresh.map(cueAsClip)].some((o) => c.startFrame < clipEnd(o) && o.startFrame < c.startFrame + c.durationFrames)
      if (clash) skipped++
      else fresh.push({ id: crypto.randomUUID(), trackId, startFrame: c.startFrame, durationFrames: c.durationFrames, text: c.text.slice(0, 2000) })
    }
    if (fresh.length > 0) commit((d) => void d.subtitles.push(...fresh))
    return { added: fresh.length, skipped }
  },

  /** Change how a subtitle track looks. Slider drags merge into one undo step. */
  setStyle(trackId: string, patch: Partial<SubtitleStyle>): boolean {
    const track = project()?.tracks.find((t) => t.id === trackId)
    if (!track || track.kind !== 'subtitle') return false
    const next = SubtitleStyleSchema.safeParse({ ...subtitleStyleOf(track), ...patch })
    if (!next.success) return false
    commit((d) => void (d.tracks.find((t) => t.id === trackId)!.subtitleStyle = next.data), `style:${trackId}`)
    return true
  }
}
