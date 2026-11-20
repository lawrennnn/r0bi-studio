import { Bot, Captions, ChevronLeft, ChevronRight, FolderCog, SlidersHorizontal, Volume2, Waypoints, type LucideIcon } from 'lucide-react'
import { framesToTimecode } from '@shared/time'
import { assetFrames } from '@shared/timeline'
import { editProject, useProjectStore } from '../store/projectStore'
import { timeline } from '../store/timelineActions'
import { AudioPanel } from './AudioPanel'
import { SubtitleEditor } from './SubtitleEditor'
import { TransitionPanel } from './TransitionPanel'
import { AssistantPanel } from './AssistantPanel'
import { Empty, NudgeRow, NumField } from './fields'
import { useUiStore, type RightTab } from '../store/uiStore'

const TABS: { id: RightTab; label: string; icon: LucideIcon }[] = [
  { id: 'project', label: 'Project', icon: FolderCog },
  { id: 'clip', label: 'Clip', icon: SlidersHorizontal },
  { id: 'audio', label: 'Audio', icon: Volume2 },
  { id: 'subtitle', label: 'Subtitles', icon: Captions },
  { id: 'transition', label: 'Transition', icon: Waypoints },
  { id: 'ai', label: 'AI assistant', icon: Bot }
]

const RESOLUTIONS = [
  { label: '1280 × 720 (720p)', w: 1280, h: 720 },
  { label: '1920 × 1080 (1080p)', w: 1920, h: 1080 },
  { label: '3840 × 2160 (4K)', w: 3840, h: 2160 }
]
const FPS = [24, 25, 30, 60]

function ProjectPanel() {
  const project = useProjectStore((s) => s.project)
  if (!project) return <Empty>Open or create a project to edit its settings.</Empty>
  const { width, height, fps } = project.settings
  const resValue = `${width}x${height}`
  const known = RESOLUTIONS.some((r) => `${r.w}x${r.h}` === resValue)
  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-ink-300">Resolution</span>
        <select
          className="field"
          value={resValue}
          onChange={(e) => {
            const [w, h] = e.target.value.split('x').map(Number)
            editProject.setSettings({ width: w, height: h })
          }}
        >
          {!known && <option value={resValue}>{width} × {height}</option>}
          {RESOLUTIONS.map((r) => <option key={r.label} value={`${r.w}x${r.h}`}>{r.label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-ink-300">Frame rate</span>
        <select className="field" value={fps} onChange={(e) => timeline.setFps(Number(e.target.value))}>
          {!FPS.includes(fps) && <option value={fps}>{fps} fps</option>}
          {FPS.map((f) => <option key={f} value={f}>{f} fps</option>)}
        </select>
      </label>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ink-300">
        <dt>Tracks</dt><dd className="text-ink-100">{project.tracks.length}</dd>
        <dt>Created</dt><dd className="text-ink-100">{new Date(project.createdAt).toLocaleDateString()}</dd>
        <dt>Last saved</dt><dd className="text-ink-100">{new Date(project.updatedAt).toLocaleString()}</dd>
      </dl>
    </div>
  )
}

function ClipPanel() {
  const project = useProjectStore((s) => s.project)
  const selectedId = useUiStore((s) => s.selectedClipId)
  const clip = project?.clips.find((c) => c.id === selectedId)
  if (!project || !clip) return <Empty>Select a clip on the timeline to edit it. Drag media from the library onto a track, or use the + button on a library item.</Empty>
  const asset = project.media.find((a) => a.id === clip.assetId)
  const track = project.tracks.find((t) => t.id === clip.trackId)
  const fps = project.settings.fps
  const locked = !!track?.locked
  const isImage = asset?.kind === 'image'
  const frames = asset ? assetFrames(asset, fps) : null
  const tc = (f: number) => framesToTimecode(f, fps)
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="truncate font-medium" title={asset?.name}>{asset?.name}</div>
        <div className="text-ink-300">{track?.name}{locked ? ' (locked)' : ''}</div>
      </div>
      <NumField label="Start (frames)" value={clip.startFrame} hint={tc(clip.startFrame)} disabled={locked} onCommit={(n) => timeline.setStart(clip.id, n)} />
      <NumField label="Duration (frames)" value={clip.durationFrames} hint={tc(clip.durationFrames)} disabled={locked} onCommit={(n) => n >= 1 && timeline.setDuration(clip.id, n)} />
      {!isImage && (
        <NumField label="Source in (frames)" value={clip.sourceInFrame} hint={tc(clip.sourceInFrame)} disabled={locked} onCommit={(n) => timeline.setSourceIn(clip.id, n)} />
      )}
      <NudgeRow fps={fps} disabled={locked} onNudge={(d) => timeline.nudge(clip.id, d)} onStartAtPlayhead={() => timeline.startAtPlayhead(clip.id)} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ink-300">
        <dt>Ends</dt><dd className="text-ink-100 tabular-nums">{tc(clip.startFrame + clip.durationFrames)}</dd>
        {!isImage && <><dt>Source out</dt><dd className="text-ink-100 tabular-nums">{tc(clip.sourceInFrame + clip.durationFrames)}{frames !== null ? ` of ${tc(frames)}` : ''}</dd></>}
      </dl>
      <div className="flex gap-2">
        <button className="btn" disabled={locked} onClick={() => timeline.split()}>Split</button>
        <button className="btn" disabled={locked} onClick={() => timeline.duplicate(clip.id)}>Duplicate</button>
        <button className="btn" disabled={locked} onClick={() => timeline.remove(clip.id)}>Delete</button>
      </div>
    </div>
  )
}

export function RightSidebar() {
  const rightTab = useUiStore((s) => s.rightTab)
  const rightCollapsed = useUiStore((s) => s.rightCollapsed)
  const patch = useUiStore((s) => s.patch)

  if (rightCollapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center bg-ink-800 py-2">
        <button className="icon-btn" title="Expand properties" onClick={() => patch({ rightCollapsed: false })}><ChevronLeft size={16} /></button>
      </aside>
    )
  }

  return (
    <aside className="flex min-w-0 flex-1 flex-col bg-ink-800">
      <div className="flex items-center border-b border-ink-950 px-1">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            title={label}
            aria-label={label}
            aria-pressed={rightTab === id}
            onClick={() => patch({ rightTab: id })}
            className={`icon-btn h-9 w-9 ${rightTab === id ? 'bg-accent-soft !text-accent' : ''}`}
          >
            <Icon size={16} />
          </button>
        ))}
        <button className="icon-btn ml-auto" title="Collapse properties" onClick={() => patch({ rightCollapsed: true })}><ChevronRight size={16} /></button>
      </div>
      <div className={`flex min-h-0 flex-1 flex-col p-3 ${rightTab === 'ai' ? 'overflow-hidden' : 'overflow-auto'}`}>
        {rightTab !== 'ai' && <h2 className="panel-title mb-3">{TABS.find((t) => t.id === rightTab)?.label}</h2>}
        {rightTab === 'project' && <ProjectPanel />}
        {rightTab === 'clip' && <ClipPanel />}
        {rightTab === 'audio' && <AudioPanel />}
        {rightTab === 'subtitle' && <SubtitleEditor />}
        {rightTab === 'transition' && <TransitionPanel />}
        {rightTab === 'ai' && <AssistantPanel />}
      </div>
    </aside>
  )
}
