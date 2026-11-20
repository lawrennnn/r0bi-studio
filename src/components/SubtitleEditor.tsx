import { Copy, Plus, Trash2 } from 'lucide-react'
import { framesToTimecode } from '@shared/time'
import { editProject, useProjectStore } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'
import { subtitleStyleOf, subtitles } from '../store/subtitleActions'
import { FONT_SUGGESTIONS } from '../lib/subtitleStyle'
import { Empty, NudgeRow, NumField, Section, Slider } from './fields'

export function SubtitleEditor() {
  const project = useProjectStore((s) => s.project)
  const selectedCueId = useUiStore((s) => s.selectedCueId)
  const subtitleTrackId = useUiStore((s) => s.subtitleTrackId)
  const patch = useUiStore((s) => s.patch)
  if (!project) return <Empty>Open or create a project to edit subtitles.</Empty>

  const fps = project.settings.fps
  const subTracks = project.tracks.filter((t) => t.kind === 'subtitle')
  const cue = project.subtitles.find((c) => c.id === selectedCueId)
  const trackId = cue?.trackId ?? (subTracks.find((t) => t.id === subtitleTrackId) ?? subTracks[0])?.id
  const track = subTracks.find((t) => t.id === trackId)
  const style = subtitleStyleOf(track)
  const locked = !!project.tracks.find((t) => t.id === cue?.trackId)?.locked
  const tc = (f: number) => framesToTimecode(f, fps)
  const set = (p: Parameters<typeof subtitles.setStyle>[1]) => track && subtitles.setStyle(track.id, p)

  if (!track) {
    return (
      <div className="flex flex-col gap-3">
        <Empty>This project has no subtitle track.</Empty>
        <button className="btn justify-center" onClick={() => editProject.addTrack('subtitle')}><Plus size={14} />Add subtitle track</button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Section title="Selected subtitle">
        {!cue ? (
          <Empty>Select a subtitle on the timeline or in the Subtitles list. Double-click an empty spot on a subtitle track to add one.</Empty>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-ink-300">Text</span>
              <textarea className="field h-24 resize-y py-1 disabled:opacity-50" disabled={locked} value={cue.text} maxLength={2000} onChange={(e) => subtitles.setText(cue.id, e.target.value)} />
            </label>
            <NumField label="Start (frames)" value={cue.startFrame} hint={tc(cue.startFrame)} disabled={locked} onCommit={(n) => subtitles.setStart(cue.id, n)} />
            <NumField label="Duration (frames)" value={cue.durationFrames} hint={tc(cue.durationFrames)} disabled={locked} min={1} onCommit={(n) => n >= 1 && subtitles.setDuration(cue.id, n)} />
            <NudgeRow fps={fps} disabled={locked} onNudge={(d) => subtitles.nudge(cue.id, d)} onStartAtPlayhead={() => subtitles.startAtPlayhead(cue.id)} />
            <div className="flex gap-2">
              <button className="btn" disabled={locked} onClick={() => subtitles.duplicate(cue.id)}><Copy size={14} />Duplicate</button>
              <button className="btn" disabled={locked} onClick={() => subtitles.remove(cue.id)}><Trash2 size={14} />Delete</button>
            </div>
          </>
        )}
      </Section>

      <Section title="Style">
        {subTracks.length > 1 ? (
          <label className="flex flex-col gap-1">
            <span className="text-ink-300">Applies to track</span>
            <select className="field" value={track.id} disabled={!!cue} onChange={(e) => patch({ subtitleTrackId: e.target.value })}>
              {subTracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        ) : (
          <p className="text-ink-300">Applies to every subtitle on {track.name}.</p>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-ink-300">Font</span>
          <input className="field" list="r0bi-fonts" value={style.fontFamily} maxLength={80} onChange={(e) => e.target.value.trim() && set({ fontFamily: e.target.value })} />
          <datalist id="r0bi-fonts">{FONT_SUGGESTIONS.map((f) => <option key={f} value={f} />)}</datalist>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <NumField label="Size (px)" value={style.fontSize} min={8} max={300} onCommit={(n) => n >= 8 && n <= 300 && !!set({ fontSize: n })} />
          <label className="flex flex-col gap-1">
            <span className="text-ink-300">Text color</span>
            <input type="color" className="h-8 w-full cursor-pointer rounded-md border border-ink-600 bg-ink-900" value={style.color} onChange={(e) => set({ color: e.target.value })} />
          </label>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={style.bold} onChange={(e) => set({ bold: e.target.checked })} className="accent-[#2f7bff]" />Bold
        </label>
        <div className="grid grid-cols-2 gap-3">
          <NumField label="Outline (px)" value={style.outlineWidth} min={0} max={20} onCommit={(n) => n >= 0 && n <= 20 && !!set({ outlineWidth: n })} />
          <label className="flex flex-col gap-1">
            <span className="text-ink-300">Outline color</span>
            <input type="color" className="h-8 w-full cursor-pointer rounded-md border border-ink-600 bg-ink-900" value={style.outlineColor} onChange={(e) => set({ outlineColor: e.target.value })} />
          </label>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Slider label="Background" value={style.bgOpacity} onChange={(v) => set({ bgOpacity: v })} />
          <input type="color" aria-label="Background color" className="h-8 w-10 cursor-pointer rounded-md border border-ink-600 bg-ink-900" value={style.bgColor} onChange={(e) => set({ bgColor: e.target.value })} />
        </div>
        <Slider label="Vertical position (0 = top, 100 = bottom)" value={style.positionY} unit="" onChange={(v) => set({ positionY: v })} />
        <button className="btn justify-center" onClick={() => set({ ...subtitleStyleOf(undefined) })}>Reset style</button>
      </Section>
    </div>
  )
}
