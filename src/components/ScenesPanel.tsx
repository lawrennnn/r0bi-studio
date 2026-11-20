import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowLeftToLine, ArrowUp, Copy, Plus, Scissors, Trash2 } from 'lucide-react'
import { framesToTimecode } from '@shared/time'
import { assetFrames, clipEnd, clipsOnTrack } from '@shared/timeline'
import { useProjectStore } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'
import { useMediaStore } from '../store/mediaStore'
import { timeline } from '../store/timelineActions'
import { NumField } from './fields'

/** The scenes are the clips on one video track, in time order: a storyboard view of the same timeline. */
export function ScenesPanel() {
  const project = useProjectStore((s) => s.project)
  const selectedId = useUiStore((s) => s.selectedClipId)
  const patch = useUiStore((s) => s.patch)
  const thumbs = useMediaStore((s) => s.thumbs)
  const [trackId, setTrackId] = useState<string | null>(null)
  const [addId, setAddId] = useState('')
  const rows = useRef(new Map<string, HTMLElement>())

  useEffect(() => {
    if (selectedId) rows.current.get(selectedId)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  if (!project) return null
  const fps = project.settings.fps
  const videoTracks = project.tracks.filter((t) => t.kind === 'video' || t.kind === 'overlay')
  const track = videoTracks.find((t) => t.id === trackId) ?? videoTracks.find((t) => project.clips.some((c) => c.trackId === t.id)) ?? videoTracks[0]
  if (!track) return <div className="rounded-md border border-dashed border-ink-600 p-4 text-center text-ink-300">This project has no video track. Add one in the timeline toolbar.</div>
  const scenes = clipsOnTrack(project.clips, track.id)
  const picture = project.media.filter((a) => a.kind !== 'audio')
  const tc = (f: number) => framesToTimecode(f, fps)
  const sec = (f: number) => (f / fps).toFixed(2)
  const toFrames = (s: number) => Math.round(s * fps)
  const selected = scenes.find((c) => c.id === selectedId)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <h2 className="panel-title">Scenes</h2>
      <p className="text-ink-300">The clips on one track, in order, as a storyboard. Reordering swaps scenes in place; audio and subtitles stay where they are.</p>
      <select className="field h-8" aria-label="Track" value={track.id} onChange={(e) => setTrackId(e.target.value)}>
        {videoTracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <div className="flex gap-1">
        <select className="field h-8" aria-label="Library item to add" value={addId} onChange={(e) => setAddId(e.target.value)}>
          <option value="">Add a scene from the library…</option>
          {picture.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button
          className="btn h-8 px-2"
          disabled={!addId || track.locked}
          title="Add after the last scene"
          onClick={() => { timeline.addAsset(addId, track.id, Math.max(0, ...scenes.map(clipEnd))); setAddId('') }}
        ><Plus size={14} /></button>
      </div>
      <div className="flex items-center gap-1 text-ink-300">
        <span className="flex-1">{scenes.length} scene{scenes.length === 1 ? '' : 's'}{scenes.length ? ` · ${tc(Math.max(...scenes.map(clipEnd)))}` : ''}</span>
        <button className="btn h-6 px-2 text-xs" disabled={track.locked || scenes.length < 2} title="Pack the scenes back to back" onClick={() => timeline.closeGaps(track.id)}>Close gaps</button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pr-1">
        {scenes.length === 0 ? (
          <div className="rounded-md border border-dashed border-ink-600 p-4 text-center text-ink-300">No scenes on {track.name} yet. Add one above, or drag media onto the track.</div>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {scenes.map((c, i) => {
              const asset = project.media.find((a) => a.id === c.assetId)
              const active = c.id === selectedId
              const total = asset ? assetFrames(asset, fps) : null
              const canSplit = !track.locked && useUiStore.getState().playhead > c.startFrame && useUiStore.getState().playhead < clipEnd(c)
              return (
                <li
                  key={c.id}
                  ref={(el) => { if (el) rows.current.set(c.id, el); else rows.current.delete(c.id) }}
                  className={`rounded-md border p-1.5 ${active ? 'border-accent bg-accent-soft' : 'border-ink-600 bg-ink-900'}`}
                >
                  <div className="flex cursor-pointer items-center gap-2" onClick={() => patch({ selectedClipId: c.id, selectedCueId: null, playhead: c.startFrame })}>
                    <span className="w-4 shrink-0 text-center text-ink-300">{i + 1}</span>
                    <div className="flex h-9 w-16 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-black">
                      {asset && thumbs[asset.id] ? <img src={thumbs[asset.id]} alt="" className="h-full w-full object-cover" draggable={false} /> : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium" title={asset?.name}>{asset?.name}</div>
                      <div className="text-[11px] text-ink-300 tabular-nums">{tc(c.startFrame)} · {sec(c.durationFrames)} s</div>
                    </div>
                  </div>
                  {c.note && !active && <div className="mt-1 truncate text-ink-300" title={c.note}>{c.note}</div>}
                  {active && (
                    <div className="mt-2 flex flex-col gap-2">
                      <div className="flex flex-wrap gap-1">
                        <button className="icon-btn icon-btn-sm" title="Move earlier" disabled={track.locked || i === 0} onClick={() => timeline.reorderScene(track.id, i, i - 1)}><ArrowUp size={14} /></button>
                        <button className="icon-btn icon-btn-sm" title="Move later" disabled={track.locked || i === scenes.length - 1} onClick={() => timeline.reorderScene(track.id, i, i + 1)}><ArrowDown size={14} /></button>
                        <button className="icon-btn icon-btn-sm" title="Duplicate" disabled={track.locked} onClick={() => timeline.duplicate(c.id)}><Copy size={14} /></button>
                        <button className="icon-btn icon-btn-sm" title="Split at the playhead" disabled={!canSplit} onClick={() => timeline.split()}><Scissors size={14} /></button>
                        <button className="icon-btn icon-btn-sm" title="Delete (leaves a gap)" disabled={track.locked} onClick={() => timeline.remove(c.id)}><Trash2 size={14} /></button>
                        <button className="icon-btn icon-btn-sm" title="Delete and close the gap" disabled={track.locked} onClick={() => timeline.rippleDelete(c.id)}><ArrowLeftToLine size={14} /></button>
                      </div>
                      {asset && asset.kind !== 'image' && (
                        <div className="grid grid-cols-3 gap-2">
                          <NumField label="In (s)" value={+(c.sourceInFrame / fps).toFixed(2)} disabled={track.locked} onCommit={(n) => timeline.setSourceIn(c.id, toFrames(n))} />
                          <NumField label="Out (s)" value={+((c.sourceInFrame + c.durationFrames) / fps).toFixed(2)} disabled={track.locked} onCommit={(n) => timeline.setDuration(c.id, toFrames(n) - c.sourceInFrame)} />
                          <NumField label="Length (s)" value={+(c.durationFrames / fps).toFixed(2)} disabled={track.locked} onCommit={(n) => n > 0 && timeline.setDuration(c.id, toFrames(n))} />
                        </div>
                      )}
                      {asset?.kind === 'image' && (
                        <NumField label="Length (s)" value={+(c.durationFrames / fps).toFixed(2)} disabled={track.locked} onCommit={(n) => n > 0 && timeline.setDuration(c.id, toFrames(n))} />
                      )}
                      {total !== null && <div className="text-[11px] text-ink-300">Source is {sec(total)} s long.</div>}
                      <label className="flex flex-col gap-1">
                        <span className="text-ink-300">Notes</span>
                        <textarea className="field h-16 resize-y py-1" maxLength={500} placeholder="A note about this scene" value={c.note ?? ''} onChange={(e) => timeline.setNote(c.id, e.target.value)} />
                      </label>
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </div>
      {selected && <div className="text-[11px] text-ink-300">Selected scene ends at {tc(clipEnd(selected))}.</div>}
    </div>
  )
}
