import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Captions, Copy, Eye, EyeOff, Film, Layers, Lock, Magnet, Maximize2, Music, Plus, Scissors, Trash2, Unlock, Volume2, VolumeX, ZoomIn, ZoomOut, type LucideIcon } from 'lucide-react'
import { TRACK_LABEL, type Clip, type SubtitleCue, type TrackKind } from '@shared/project'
import { canPlace, clipAsCue, clipEnd, CUE_ASSET, cueAsClip, defaultClipFrames, findFreeStart, snapEdge, snapPoints, snapStart, trimLeft, trimRight } from '@shared/timeline'
import { editProject, useProjectStore } from '../store/projectStore'
import { clamp, useUiStore } from '../store/uiStore'
import { useMediaStore } from '../store/mediaStore'
import { timeline } from '../store/timelineActions'
import { subtitles } from '../store/subtitleActions'
import { ClipBlock, CueBlock } from './ClipBlock'

const HEADER_W = 184
const ROW_H = 40
const SNAP_PX = 8
const MIN_SECONDS = 120
const ICON: Record<TrackKind, LucideIcon> = { video: Film, audio: Music, subtitle: Captions, overlay: Layers }

function tickStep(zoom: number): number {
  if (zoom >= 80) return 1
  if (zoom >= 30) return 5
  if (zoom >= 14) return 10
  return 30
}
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

interface DragPreview {
  clipId: string
  /** Cues are dragged as clip-shaped stand-ins so the same placement rules apply. */
  clip: Clip
  isCue: boolean
  snap: number | null
}
interface Ghost {
  trackId: string
  start: number
  duration: number
}

/** Own component so only the playhead line re-renders on every frame during playback. */
function PlayheadLine({ fps, zoom }: { fps: number; zoom: number }) {
  const playhead = useUiStore((s) => s.playhead)
  return (
    <div className="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-accent" style={{ left: HEADER_W + (playhead / fps) * zoom }} aria-hidden="true">
      <div className="absolute -left-[5px] top-0 h-3 w-[11px] rounded-b-sm bg-accent" />
    </div>
  )
}

export function Timeline() {
  const project = useProjectStore((s) => s.project)
  const { zoom, snapping, selectedClipId, selectedCueId, dragAsset } = useUiStore(
    useShallow((s) => ({ zoom: s.zoom, snapping: s.snapping, selectedClipId: s.selectedClipId, selectedCueId: s.selectedCueId, dragAsset: s.dragAsset }))
  )
  const patch = useUiStore((s) => s.patch)
  const thumbs = useMediaStore((s) => s.thumbs)
  const missing = useMediaStore((s) => s.missing)
  const waveforms = useMediaStore((s) => s.waveforms)
  const lanesRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragPreview | null>(null)
  const [ghost, setGhost] = useState<Ghost | null>(null)

  const fps = project?.settings.fps ?? 30
  const clips = (project?.clips ?? []).map((c) => (drag && !drag.isCue && c.id === drag.clipId ? drag.clip : c))
  const cues = (project?.subtitles ?? []).map((c) => (drag?.isCue && c.id === drag.clipId ? clipAsCue(drag.clip, c.text) : c))
  const lastFrame = Math.max(0, ...clips.map(clipEnd), ...cues.map(clipEnd))
  const seconds = Math.max(MIN_SECONDS, Math.ceil(lastFrame / fps) + 30)
  const width = seconds * zoom
  const step = tickStep(zoom)
  const ticks = Array.from({ length: Math.floor(seconds / step) + 1 }, (_, i) => i * step)
  const selected = project?.clips.find((c) => c.id === selectedClipId) ?? null
  const selectedCue = project?.subtitles.find((c) => c.id === selectedCueId) ?? null
  const threshold = Math.max(1, Math.round((SNAP_PX / zoom) * fps))

  const seek = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    patch({ playhead: Math.max(0, Math.round(((e.clientX - rect.left) / zoom) * fps)) })
  }

  // While playing, scroll so the playhead stays visible.
  useEffect(() => {
    return useUiStore.subscribe((state, prev) => {
      const el = scrollRef.current
      if (!el || !state.playing || state.playhead === prev.playhead) return
      const f = useProjectStore.getState().project?.settings.fps ?? 30
      const x = HEADER_W + (state.playhead / f) * state.zoom
      if (x < el.scrollLeft + HEADER_W || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, x - HEADER_W - 80)
    })
  }, [])

  const fit = () => {
    const viewport = (scrollRef.current?.clientWidth ?? 800) - HEADER_W - 24
    const secs = Math.max(5, lastFrame / fps)
    patch({ zoom: clamp(Math.floor(viewport / secs), 8, 240) })
  }

  const beginDrag = (e: React.PointerEvent, source: Clip | SubtitleCue, mode: 'move' | 'trimL' | 'trimR', isCue: boolean) => {
    if (e.button !== 0 || !project) return
    e.stopPropagation()
    e.preventDefault()
    const clip: Clip = isCue ? cueAsClip(source as SubtitleCue) : (source as Clip)
    const cueText = isCue ? (source as SubtitleCue).text : ''
    patch(isCue ? { selectedCueId: clip.id, selectedClipId: null, rightTab: 'subtitle' } : { selectedClipId: clip.id, selectedCueId: null })
    const track = project.tracks.find((t) => t.id === clip.trackId)
    const asset = isCue ? CUE_ASSET : project.media.find((a) => a.id === clip.assetId)
    if (!track || !asset || track.locked) return

    // Everything that shares the placement rules with the dragged item (same kind), and snap targets from both kinds.
    const peers = isCue ? project.subtitles.map(cueAsClip) : project.clips
    const startX = e.clientX
    const startY = e.clientY
    const points = snapping ? snapPoints([...project.clips, ...project.subtitles.map(cueAsClip)], clip.id, useUiStore.getState().playhead) : []
    let preview: Clip = clip
    let moved = false

    const compute = (ev: PointerEvent): DragPreview => {
      const dx = Math.round(((ev.clientX - startX) / zoom) * fps)
      if (mode === 'trimL') {
        const edge = snapEdge(clip.startFrame + dx, points, threshold)
        return { clipId: clip.id, isCue, clip: trimLeft(clip, edge.frame, peers, asset), snap: edge.snapped }
      }
      if (mode === 'trimR') {
        const edge = snapEdge(clipEnd(clip) + dx, points, threshold)
        return { clipId: clip.id, isCue, clip: trimRight(clip, edge.frame, peers, asset, fps), snap: edge.snapped }
      }
      let desired = clip.startFrame + dx
      let snap: number | null = null
      if (points.length > 0) {
        const r = snapStart(desired, clip.durationFrames, points, threshold)
        desired = r.start
        snap = r.snapped
      }
      let target = track
      const rect = lanesRef.current?.getBoundingClientRect()
      if (rect) {
        const idx = clamp(Math.floor((ev.clientY - rect.top) / ROW_H), 0, project.tracks.length - 1)
        const t = project.tracks[idx]
        const accepts = isCue ? t.kind === 'subtitle' : canPlace(t.kind, (asset as { kind: 'video' | 'audio' | 'image' }).kind)
        if (accepts && !t.locked) target = t
      }
      const start = findFreeStart(peers, target.id, clip.durationFrames, desired, clip.id)
      return { clipId: clip.id, isCue, clip: { ...clip, trackId: target.id, startFrame: start }, snap: start === desired ? snap : null }
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey)
      document.body.style.cursor = ''
    }
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return
      moved = true
      const next = compute(ev)
      preview = next.clip
      setDrag(next)
    }
    const onUp = () => {
      cleanup()
      setDrag(null)
      if (!moved || JSON.stringify(preview) === JSON.stringify(clip)) return
      if (isCue) subtitles.replaceCue(clipAsCue(preview, cueText))
      else timeline.replaceClip(preview)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        cleanup()
        setDrag(null)
      }
    }
    document.body.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
  }

  const laneFrame = (e: React.DragEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.round(((e.clientX - rect.left) / zoom) * fps))
  }

  const onLaneDragOver = (e: React.DragEvent<HTMLDivElement>, trackId: string) => {
    if (!project || !dragAsset) return
    const track = project.tracks.find((t) => t.id === trackId)
    const asset = project.media.find((a) => a.id === dragAsset.id)
    if (!track || !asset || track.locked || !canPlace(track.kind, asset.kind)) {
      e.dataTransfer.dropEffect = 'none'
      if (ghost) setGhost(null)
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const duration = defaultClipFrames(asset, fps)
    let desired = laneFrame(e)
    if (snapping) desired = snapStart(desired, duration, snapPoints(project.clips, null, useUiStore.getState().playhead), threshold).start
    const start = findFreeStart(project.clips, trackId, duration, desired)
    if (!ghost || ghost.trackId !== trackId || ghost.start !== start) setGhost({ trackId, start, duration })
  }

  const onLaneDrop = (e: React.DragEvent<HTMLDivElement>, trackId: string) => {
    const id = e.dataTransfer.getData('application/x-r0bi-asset')
    if (!id) return
    e.preventDefault()
    const start = ghost?.trackId === trackId ? ghost.start : laneFrame(e)
    setGhost(null)
    timeline.addAsset(id, trackId, start)
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-ink-800" aria-label="Timeline">
      <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-ink-950 px-2">
        {(['video', 'audio', 'subtitle', 'overlay'] as const).map((kind) => (
          <button key={kind} className="btn h-7 shrink-0 px-2 text-xs" disabled={!project} onClick={() => editProject.addTrack(kind)} title={`Add ${TRACK_LABEL[kind].toLowerCase()} track`}>
            <Plus size={13} />{TRACK_LABEL[kind]}
          </button>
        ))}
        <div className="mx-1 h-5 w-px shrink-0 bg-ink-600" />
        <button className="icon-btn" title="Split at playhead (S)" disabled={!project} onClick={() => timeline.split()}><Scissors size={15} /></button>
        <button className="icon-btn" title="Duplicate (Ctrl+D)" disabled={!selected && !selectedCue} onClick={() => (selected ? timeline.duplicate(selected.id) : selectedCue && subtitles.duplicate(selectedCue.id))}><Copy size={15} /></button>
        <button className="icon-btn" title="Delete (Delete)" disabled={!selected && !selectedCue} onClick={() => (selected ? timeline.remove(selected.id) : selectedCue && subtitles.remove(selectedCue.id))}><Trash2 size={15} /></button>
        <button className={`icon-btn ${snapping ? 'bg-accent-soft !text-accent' : ''}`} aria-pressed={snapping} title={snapping ? 'Snapping on' : 'Snapping off'} onClick={() => patch({ snapping: !snapping })}><Magnet size={15} /></button>
        <div className="ml-auto flex shrink-0 items-center gap-2 text-ink-300">
          <button className="icon-btn icon-btn-sm" title="Fit timeline to window" disabled={!project} onClick={fit}><Maximize2 size={14} /></button>
          <button className="icon-btn icon-btn-sm" title="Zoom out" onClick={() => patch({ zoom: clamp(Math.round(zoom / 1.25), 8, 240) })}><ZoomOut size={15} /></button>
          <input type="range" aria-label="Timeline zoom" min={8} max={240} value={zoom} onChange={(e) => patch({ zoom: Number(e.target.value) })} className="w-28 accent-[#2f7bff]" />
          <button className="icon-btn icon-btn-sm" title="Zoom in" onClick={() => patch({ zoom: clamp(Math.round(zoom * 1.25), 8, 240) })}><ZoomIn size={15} /></button>
        </div>
      </div>

      {!project ? (
        <div className="flex flex-1 items-center justify-center text-ink-300">Open or create a project to see its timeline.</div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" onPointerDown={(e) => { if (e.target === e.currentTarget) patch({ selectedClipId: null, selectedCueId: null }) }}>
          <div className="relative" style={{ width: HEADER_W + width }}>
            <div className="sticky top-0 z-20 flex h-7 border-b border-ink-950 bg-ink-800">
              <div className="sticky left-0 z-30 shrink-0 border-r border-ink-950 bg-ink-800" style={{ width: HEADER_W }} />
              <div
                className="relative flex-1 cursor-pointer"
                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seek(e) }}
                onPointerMove={(e) => e.buttons === 1 && seek(e)}
                aria-label="Timeline ruler"
              >
                {ticks.map((t) => (
                  <div key={t} className="absolute top-0 h-full border-l border-ink-500 pl-1 text-[10px] text-ink-300" style={{ left: t * zoom }}>{mmss(t)}</div>
                ))}
              </div>
            </div>

            <div ref={lanesRef}>
              {project.tracks.map((track) => {
                const Icon = ICON[track.kind]
                const hasAudio = track.kind === 'audio' || track.kind === 'video'
                const hasVisibility = track.kind !== 'audio'
                return (
                  <div key={track.id} className="flex border-b border-ink-950" style={{ height: ROW_H }}>
                    <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-ink-950 bg-ink-800 px-2" style={{ width: HEADER_W }}>
                      <Icon size={14} className="shrink-0 text-ink-300" />
                      <span className="min-w-0 flex-1 truncate">{track.name}</span>
                      {hasVisibility && (
                        <button className="icon-btn icon-btn-sm" title={track.visible ? 'Hide track' : 'Show track'} aria-pressed={!track.visible} onClick={() => editProject.toggleTrack(track.id, 'visible')}>
                          {track.visible ? <Eye size={14} /> : <EyeOff size={14} className="text-accent" />}
                        </button>
                      )}
                      {hasAudio && (
                        <button className="icon-btn icon-btn-sm" title={track.muted ? 'Unmute track' : 'Mute track'} aria-pressed={track.muted} onClick={() => editProject.toggleTrack(track.id, 'muted')}>
                          {track.muted ? <VolumeX size={14} className="text-accent" /> : <Volume2 size={14} />}
                        </button>
                      )}
                      <button className="icon-btn icon-btn-sm" title={track.locked ? 'Unlock track' : 'Lock track'} aria-pressed={track.locked} onClick={() => editProject.toggleTrack(track.id, 'locked')}>
                        {track.locked ? <Lock size={14} className="text-accent" /> : <Unlock size={14} />}
                      </button>
                    </div>
                    <div
                      className={`relative flex-1 ${track.locked ? 'bg-[repeating-linear-gradient(135deg,#1a1d23,#1a1d23_6px,#1e2128_6px,#1e2128_12px)]' : 'bg-ink-900'}`}
                      onPointerDown={() => patch({ selectedClipId: null, selectedCueId: null })}
                      onDoubleClick={(e) => {
                        if (track.kind !== 'subtitle' || e.target !== e.currentTarget) return
                        const rect = e.currentTarget.getBoundingClientRect()
                        subtitles.addCue(track.id, Math.round(((e.clientX - rect.left) / zoom) * fps))
                      }}
                      onDragOver={(e) => onLaneDragOver(e, track.id)}
                      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setGhost(null) }}
                      onDrop={(e) => onLaneDrop(e, track.id)}
                    >
                      <div className={`absolute inset-0 ${track.visible ? '' : 'opacity-40'}`}>
                        {track.kind === 'subtitle'
                          ? cues.filter((c) => c.trackId === track.id).map((c) => (
                              <CueBlock
                                key={c.id}
                                cue={c}
                                zoom={zoom}
                                fps={fps}
                                selected={c.id === selectedCueId}
                                locked={track.locked}
                                dragging={drag?.clipId === c.id}
                                onPointerDown={(e, mode) => beginDrag(e, c, mode, true)}
                              />
                            ))
                          : clips.filter((c) => c.trackId === track.id).map((c) => {
                              const asset = project.media.find((a) => a.id === c.assetId)
                              if (!asset) return null
                              return (
                                <ClipBlock
                                  key={c.id}
                                  clip={c}
                                  asset={asset}
                                  trackKind={track.kind}
                                  zoom={zoom}
                                  fps={fps}
                                  thumb={thumbs[asset.id]}
                                  peaks={waveforms[asset.id]}
                                  selected={c.id === selectedClipId}
                                  missing={!!missing[asset.id]}
                                  locked={track.locked}
                                  dragging={drag?.clipId === c.id}
                                  onPointerDown={(e, mode) => beginDrag(e, c, mode, false)}
                                />
                              )
                            })}
                      </div>
                      {ghost?.trackId === track.id && (
                        <div className="pointer-events-none absolute bottom-1 top-1 rounded border-2 border-dashed border-accent bg-accent-soft" style={{ left: (ghost.start / fps) * zoom, width: Math.max(2, (ghost.duration / fps) * zoom) }} />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {drag?.snap != null && (
              <div className="pointer-events-none absolute bottom-0 top-7 z-30 w-px bg-amber-400" style={{ left: HEADER_W + (drag.snap / fps) * zoom }} aria-hidden="true" />
            )}
            <PlayheadLine fps={fps} zoom={zoom} />
          </div>
        </div>
      )}
    </section>
  )
}
