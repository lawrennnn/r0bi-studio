import { useEffect, useRef } from 'react'
import { FileText, Plus, X } from 'lucide-react'
import { framesToTimecode } from '@shared/time'
import { editProject, useProjectStore } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'
import { useMediaStore } from '../store/mediaStore'
import { subtitles } from '../store/subtitleActions'
import { importSrt } from '../lib/subtitleImport'

export function SubtitlesPanel() {
  const project = useProjectStore((s) => s.project)
  const playhead = useUiStore((s) => s.playhead)
  const selectedCueId = useUiStore((s) => s.selectedCueId)
  const subtitleTrackId = useUiStore((s) => s.subtitleTrackId)
  const patch = useUiStore((s) => s.patch)
  const notice = useMediaStore((s) => s.notice)
  const setMedia = useMediaStore((s) => s.patch)
  const rowRefs = useRef(new Map<string, HTMLElement>())

  useEffect(() => {
    if (selectedCueId) rowRefs.current.get(selectedCueId)?.scrollIntoView({ block: 'nearest' })
  }, [selectedCueId])

  if (!project) return null
  const fps = project.settings.fps
  const subTracks = project.tracks.filter((t) => t.kind === 'subtitle')
  const track = subTracks.find((t) => t.id === subtitleTrackId) ?? subTracks[0]
  const cues = track ? project.subtitles.filter((c) => c.trackId === track.id).sort((a, b) => a.startFrame - b.startFrame) : []
  const tc = (f: number) => framesToTimecode(f, fps)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-1">
        <h2 className="panel-title flex-1">Subtitles</h2>
        <button className="btn h-7 px-2 text-xs" onClick={() => void importSrt()} title="Import an .srt file into a new subtitle track"><FileText size={13} />Import SRT</button>
        <button className="btn h-7 px-2 text-xs" disabled={!track || track.locked} onClick={() => track && subtitles.addCue(track.id)} title="Add a subtitle at the playhead"><Plus size={13} />Add</button>
      </div>

      {notice && (
        <div role="status" className="flex items-start gap-2 rounded-md bg-ink-700 p-2 text-ink-200">
          <span className="flex-1">{notice}</span>
          <button className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={() => setMedia({ notice: null })}><X size={12} /></button>
        </div>
      )}

      {subTracks.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-ink-600 p-4 text-center text-ink-300">
          No subtitle track yet.
          <button className="btn" onClick={() => editProject.addTrack('subtitle')}><Plus size={14} />Add subtitle track</button>
        </div>
      ) : (
        <>
          {subTracks.length > 1 && (
            <select className="field" aria-label="Subtitle track" value={track?.id} onChange={(e) => patch({ subtitleTrackId: e.target.value })}>
              {subTracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <div className="min-h-0 flex-1 overflow-auto">
            {cues.length === 0 ? (
              <div className="flex h-full min-h-32 items-center justify-center rounded-md border border-dashed border-ink-600 p-4 text-center text-ink-300">
                No subtitles on {track?.name}.<br />Import an SRT file, or press Add.
              </div>
            ) : (
              <ol className="flex flex-col gap-1">
                {cues.map((c, i) => {
                  const active = playhead >= c.startFrame && playhead < c.startFrame + c.durationFrames
                  const selected = c.id === selectedCueId
                  return (
                    <li
                      key={c.id}
                      ref={(el) => { if (el) rowRefs.current.set(c.id, el); else rowRefs.current.delete(c.id) }}
                      onClick={() => patch({ selectedCueId: c.id, selectedClipId: null, playhead: c.startFrame })}
                      className={`cursor-pointer rounded-md border p-1.5 ${selected ? 'border-accent' : 'border-ink-600 hover:border-ink-500'} ${active ? 'bg-accent-soft' : 'bg-ink-900'}`}
                    >
                      <div className="mb-1 flex justify-between text-[11px] text-ink-300 tabular-nums">
                        <span>{i + 1}</span>
                        <span>{tc(c.startFrame)} → {tc(c.startFrame + c.durationFrames)}</span>
                      </div>
                      <textarea
                        aria-label={`Subtitle ${i + 1} text`}
                        className="field h-auto min-h-[2.25rem] resize-none py-1 leading-snug"
                        rows={Math.min(4, c.text.split('\n').length + (c.text.length > 40 ? 1 : 0))}
                        value={c.text}
                        maxLength={2000}
                        disabled={track?.locked}
                        onFocus={() => patch({ selectedCueId: c.id, selectedClipId: null })}
                        onChange={(e) => subtitles.setText(c.id, e.target.value)}
                      />
                    </li>
                  )
                })}
              </ol>
            )}
          </div>
        </>
      )}
    </div>
  )
}
