import { useState } from 'react'
import { Clapperboard, FileStack, Layers, Loader2, Trash2, Wand2, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { framesToTimecode } from '@shared/time'
import type { Recipe, Scene, Template } from '@shared/automation'
import { timelineEnd } from '@shared/timeline'
import { useProjectStore } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'
import { useAutomationStore, type AutomationTab } from '../store/automationStore'
import { applyTemplateToProject, assembleNow, insertSceneAtPlayhead, newProjectFromTemplate, removeItem, saveScene, saveTemplate } from '../lib/automationActions'
import { formatDuration } from '../lib/format'

const TABS: { id: AutomationTab; label: string; icon: typeof Wand2 }[] = [
  { id: 'assemble', label: 'Assemble', icon: Wand2 },
  { id: 'templates', label: 'Templates', icon: FileStack },
  { id: 'scenes', label: 'Scenes', icon: Clapperboard }
]

function Num({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange(n: number): void }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-ink-300">{label}</span>
      <input
        key={value}
        type="number"
        className="field h-7"
        min={min}
        max={max}
        step={step}
        defaultValue={value}
        onBlur={(e) => {
          const n = Number(e.currentTarget.value)
          if (Number.isFinite(n) && n >= min && n <= max) onChange(n)
          else e.currentTarget.value = String(value)
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </label>
  )
}

function Assemble() {
  const project = useProjectStore((s) => s.project)
  const { recipe, sceneIds, narrationId, musicId, mode } = useAutomationStore(useShallow((s) => ({ recipe: s.recipe, sceneIds: s.sceneIds, narrationId: s.narrationId, musicId: s.musicId, mode: s.mode })))
  const patch = useAutomationStore((s) => s.patch)
  const setRecipe = useAutomationStore((s) => s.setRecipe)
  if (!project) return null
  const picture = project.media.filter((a) => a.kind !== 'audio')
  const audio = project.media.filter((a) => a.kind === 'audio')
  const toggle = (id: string) => patch({ sceneIds: sceneIds.includes(id) ? sceneIds.filter((x) => x !== id) : [...sceneIds, id] })
  const text = (key: 'videoTrack' | 'narrationTrack' | 'musicTrack', label: string) => (
    <label className="flex flex-col gap-0.5">
      <span className="text-ink-300">{label}</span>
      <input className="field h-7" maxLength={40} defaultValue={recipe[key]} key={recipe[key]} onBlur={(e) => (e.currentTarget.value.trim() ? setRecipe({ [key]: e.currentTarget.value.trim() }) : (e.currentTarget.value = recipe[key]))} />
    </label>
  )

  return (
    <div className="flex flex-col gap-3">
      <p className="text-ink-300">Lay scenes out in order with narration and music, following the recipe below. Click scenes in the order they should play.</p>
      <div className="flex items-center">
        <span className="panel-title flex-1">Scenes ({sceneIds.length})</span>
        <button className="btn h-6 px-2 text-xs" onClick={() => patch({ sceneIds: picture.map((a) => a.id) })} disabled={picture.length === 0}>Use all</button>
        <button className="btn ml-1 h-6 px-2 text-xs" onClick={() => patch({ sceneIds: [] })} disabled={sceneIds.length === 0}>Clear</button>
      </div>
      {picture.length === 0 ? (
        <div className="rounded-md border border-dashed border-ink-600 p-3 text-center text-ink-300">Import video or image files in the Media tab first.</div>
      ) : (
        <ul className="flex max-h-44 flex-col gap-1 overflow-auto">
          {picture.map((a) => {
            const n = sceneIds.indexOf(a.id)
            return (
              <li key={a.id}>
                <button className={`flex w-full items-center gap-2 rounded-md border px-2 py-1 text-left ${n >= 0 ? 'border-accent bg-accent-soft' : 'border-ink-600 hover:border-ink-500'}`} aria-pressed={n >= 0} onClick={() => toggle(a.id)}>
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${n >= 0 ? 'bg-accent text-white' : 'bg-ink-600'}`}>{n >= 0 ? n + 1 : ''}</span>
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  <span className="text-ink-300">{a.kind === 'image' ? 'image' : formatDuration(a.durationMs)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <label className="flex flex-col gap-0.5">
        <span className="text-ink-300">Narration</span>
        <select className="field h-8" value={narrationId ?? ''} onChange={(e) => patch({ narrationId: e.target.value || null })}>
          <option value="">None</option>
          {audio.map((a) => <option key={a.id} value={a.id}>{a.name} ({formatDuration(a.durationMs)})</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-ink-300">Background music</span>
        <select className="field h-8" value={musicId ?? ''} onChange={(e) => patch({ musicId: e.target.value || null })}>
          <option value="">None</option>
          {audio.map((a) => <option key={a.id} value={a.id}>{a.name} ({formatDuration(a.durationMs)})</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-ink-300">What happens to the tracks the recipe uses</span>
        <select className="field h-8" value={mode} onChange={(e) => patch({ mode: e.target.value as 'replace' | 'append' })}>
          <option value="replace">Replace what is on them</option>
          <option value="append">Add after what is on the video track</option>
        </select>
      </label>

      <details className="rounded-md border border-ink-600 p-2">
        <summary className="cursor-pointer text-ink-200">Recipe</summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {text('videoTrack', 'Scenes track')}
          {text('narrationTrack', 'Narration track')}
          {text('musicTrack', 'Music track')}
          <Num label="Still image (s)" value={recipe.stillSeconds} min={0.5} max={60} step={0.5} onChange={(n) => setRecipe({ stillSeconds: n })} />
          <Num label="Scene fade (s)" value={recipe.fadeSeconds} min={0} max={5} step={0.1} onChange={(n) => setRecipe({ fadeSeconds: n })} />
          <Num label="Narration %" value={recipe.narrationVolume} min={0} max={100} onChange={(n) => setRecipe({ narrationVolume: Math.round(n) })} />
          <Num label="Music %" value={recipe.musicVolume} min={0} max={100} onChange={(n) => setRecipe({ musicVolume: Math.round(n) })} />
          <Num label="Music fade in (s)" value={recipe.musicFadeInSeconds} min={0} max={30} step={0.5} onChange={(n) => setRecipe({ musicFadeInSeconds: n })} />
          <Num label="Music fade out (s)" value={recipe.musicFadeOutSeconds} min={0} max={30} step={0.5} onChange={(n) => setRecipe({ musicFadeOutSeconds: n })} />
        </div>
        <label className="mt-2 flex items-start gap-2 text-ink-300">
          <input type="checkbox" className="mt-0.5 accent-[#2f7bff]" checked={recipe.fitToNarration} onChange={(e) => setRecipe({ fitToNarration: e.target.checked } as Partial<Recipe>)} />
          <span>Stretch still images so the pictures last as long as the narration</span>
        </label>
      </details>
      <button className="btn btn-primary justify-center" disabled={sceneIds.length === 0} onClick={() => assembleNow()}><Wand2 size={14} />Assemble</button>
    </div>
  )
}

function Templates() {
  const project = useProjectStore((s) => s.project)
  const data = useAutomationStore((s) => s.data)
  const busy = useAutomationStore((s) => s.busy)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [projectName, setProjectName] = useState('')
  if (!project) return null
  const templates = data?.templates ?? []
  return (
    <div className="flex flex-col gap-3">
      <p className="text-ink-300">A template keeps this project's tracks, levels, subtitle look, size, export settings and assembly recipe, but not its clips.</p>
      <input className="field" placeholder="Template name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      <input className="field" placeholder="Description (optional)" maxLength={300} value={desc} onChange={(e) => setDesc(e.target.value)} />
      <button className="btn justify-center" disabled={!name.trim()} onClick={() => { void saveTemplate(name, desc); setName(''); setDesc('') }}>Save this project as a template</button>

      <input className="field" placeholder="Name for new projects (optional)" maxLength={80} value={projectName} onChange={(e) => setProjectName(e.target.value)} />
      {templates.length === 0 ? (
        <div className="rounded-md border border-dashed border-ink-600 p-3 text-center text-ink-300">No templates yet.</div>
      ) : (
        <ul className="flex flex-col gap-2">
          {templates.map((t: Template) => (
            <li key={t.id} className="rounded-md border border-ink-600 bg-ink-900 p-2">
              <div className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate font-medium" title={t.name}>{t.name}</span>
                <button className="icon-btn icon-btn-sm" title="Delete template" onClick={() => window.confirm(`Delete the template "${t.name}"?`) && void removeItem('templates', t.id)}><Trash2 size={13} /></button>
              </div>
              <div className="text-ink-300">{t.settings.width}×{t.settings.height} · {t.settings.fps} fps · {t.tracks.length} tracks</div>
              {t.description && <div className="text-ink-300">{t.description}</div>}
              <div className="mt-2 flex gap-1">
                <button className="btn h-7 px-2 text-xs" title="Add its tracks and looks to this project. Clips are not touched." onClick={() => applyTemplateToProject(t)}>Apply here</button>
                <button className="btn h-7 px-2 text-xs" disabled={busy} onClick={() => void newProjectFromTemplate(t, projectName)}>New project…</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Scenes() {
  const project = useProjectStore((s) => s.project)
  const selectedClipId = useUiStore((s) => s.selectedClipId)
  const data = useAutomationStore((s) => s.data)
  const busy = useAutomationStore((s) => s.busy)
  const [name, setName] = useState('')
  const [from, setFrom] = useState<number | null>(null)
  const [to, setTo] = useState<number | null>(null)
  if (!project) return null
  const fps = project.settings.fps
  const end = timelineEnd(project) / fps
  const start = from ?? 0
  const stop = to ?? end
  const sel = project.clips.find((c) => c.id === selectedClipId)
  const scenes = data?.scenes ?? []
  return (
    <div className="flex flex-col gap-3">
      <p className="text-ink-300">Save part of the timeline as a scene, then drop it into any project at the playhead.</p>
      <input className="field" placeholder="Scene name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      <div className="grid grid-cols-2 gap-2">
        <Num label="From (s)" value={start} min={0} max={86400} step={0.1} onChange={setFrom} />
        <Num label="To (s)" value={stop} min={0} max={86400} step={0.1} onChange={setTo} />
      </div>
      <div className="flex gap-1">
        <button className="btn h-7 px-2 text-xs" disabled={!sel} onClick={() => sel && (setFrom(sel.startFrame / fps), setTo((sel.startFrame + sel.durationFrames) / fps))}>Use selected clip's time</button>
        <button className="btn h-7 px-2 text-xs" onClick={() => (setFrom(null), setTo(null))}>Whole timeline</button>
      </div>
      <button className="btn justify-center" disabled={!name.trim() || stop <= start} onClick={() => { void saveScene(name, start, stop); setName('') }}><Layers size={14} />Save as scene</button>

      {scenes.length === 0 ? (
        <div className="rounded-md border border-dashed border-ink-600 p-3 text-center text-ink-300">No saved scenes yet.</div>
      ) : (
        <ul className="flex flex-col gap-2">
          {scenes.map((s: Scene) => (
            <li key={s.id} className="rounded-md border border-ink-600 bg-ink-900 p-2">
              <div className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate font-medium" title={s.name}>{s.name}</span>
                <button className="icon-btn icon-btn-sm" title="Delete scene" onClick={() => window.confirm(`Delete the scene "${s.name}"?`) && void removeItem('scenes', s.id)}><Trash2 size={13} /></button>
              </div>
              <div className="text-ink-300">{framesToTimecode(s.durationFrames, s.fps)} · {s.clips.length} clips{s.subtitles.length ? ` · ${s.subtitles.length} subtitles` : ''}</div>
              <button className="btn mt-2 h-7 px-2 text-xs" disabled={busy} onClick={() => void insertSceneAtPlayhead(s)}>{busy ? <Loader2 size={13} className="animate-spin" /> : null}Insert at playhead</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function AutomationPanel() {
  const tab = useAutomationStore((s) => s.tab)
  const notice = useAutomationStore((s) => s.notice)
  const patch = useAutomationStore((s) => s.patch)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <h2 className="panel-title">Automation</h2>
      <div className="flex gap-1" role="tablist">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`btn h-7 flex-1 justify-center px-1 text-xs ${tab === id ? 'border-accent bg-accent-soft' : ''}`} onClick={() => patch({ tab: id })}><Icon size={12} />{label}</button>
        ))}
      </div>
      {notice && (
        <div role="status" className="flex items-start gap-2 rounded-md bg-ink-700 p-2 text-ink-200">
          <span className="flex-1">{notice}</span>
          <button className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={() => patch({ notice: null })}><X size={12} /></button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto pr-1">
        {tab === 'assemble' && <Assemble />}
        {tab === 'templates' && <Templates />}
        {tab === 'scenes' && <Scenes />}
      </div>
    </div>
  )
}
