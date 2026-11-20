import { useEffect, useState } from 'react'
import { CheckCircle2, FolderOpen, Loader2, TriangleAlert, X, XCircle } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { ExportJobInfo } from '@shared/api'
import { outputSize, QUALITY_PRESETS, RESOLUTIONS, type ExportSettings } from '@shared/render'
import { timelineEnd } from '@shared/timeline'
import { framesToTimecode } from '@shared/time'
import { useProjectStore } from '../store/projectStore'
import { isActive, useExportStore } from '../store/exportStore'
import { chooseOutputFolder, loadExportInfo, queueExport } from '../lib/exportActions'
import { BUILTIN_PRESETS, presetToSettings } from '@shared/automation'
import { useAutomationStore } from '../store/automationStore'
import { savePreset } from '../lib/automationActions'

const STATUS: Record<ExportJobInfo['status'], string> = {
  queued: 'Waiting', preparing: 'Preparing', rendering: 'Rendering', verifying: 'Checking the file',
  done: 'Finished', failed: 'Failed', cancelled: 'Cancelled'
}

function eta(job: ExportJobInfo, now: number): string {
  if (job.status !== 'rendering' || !job.startedAt || job.progress < 0.03) return ''
  const left = ((now - job.startedAt) * (1 - job.progress)) / job.progress / 1000
  if (!Number.isFinite(left)) return ''
  return left < 60 ? `about ${Math.max(1, Math.round(left))} s left` : `about ${Math.round(left / 60)} min left`
}

function Job({ job }: { job: ExportJobInfo }) {
  const api = window.r0bi
  const pct = Math.round(job.progress * 100)
  const active = isActive(job)
  const v = job.verification
  return (
    <li className="rounded-md border border-ink-600 bg-ink-900 p-3">
      <div className="flex items-center gap-2">
        {job.status === 'done' ? <CheckCircle2 size={16} className="shrink-0 text-emerald-400" /> : job.status === 'failed' ? <XCircle size={16} className="shrink-0 text-red-400" /> : active ? <Loader2 size={16} className="shrink-0 animate-spin text-accent" /> : <X size={16} className="shrink-0 text-ink-300" />}
        <span className="min-w-0 flex-1 truncate font-medium" title={job.name}>{job.name}</span>
        <span className="text-ink-300">{STATUS[job.status]}</span>
        {active && <button className="btn h-7 px-2 text-xs" onClick={() => void api?.export.cancel(job.id)}>Cancel</button>}
        {job.status === 'done' && <button className="btn h-7 px-2 text-xs" onClick={() => void api?.export.reveal(job.id)}><FolderOpen size={13} />Show in folder</button>}
      </div>
      {(active || job.status === 'done') && (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-2 flex-1 overflow-hidden rounded bg-ink-600" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <span className="w-10 text-right tabular-nums">{pct}%</span>
        </div>
      )}
      {active && <div className="mt-1 text-ink-300">{eta(job, Date.now())}</div>}
      {job.note && <div className="mt-1 flex items-start gap-1 text-amber-200"><TriangleAlert size={13} className="mt-0.5 shrink-0" />{job.note}</div>}
      {job.error && <div className="mt-1 break-words text-red-300">{job.error}</div>}
      {job.status === 'done' && v && (
        <div className="mt-1 text-ink-300">
          Checked: {v.width}×{v.height}, {v.fps.toFixed(2)} fps, {v.videoCodec?.toUpperCase()} + {v.audioCodec?.toUpperCase()}, {v.durationSec.toFixed(1)} s
          {job.encoder ? ` · ${job.encoder === 'nvenc' ? 'NVIDIA GPU' : 'CPU'} encode` : ''}
        </div>
      )}
      {job.status === 'done' && job.outputPath && <div className="mt-1 break-all text-ink-300">{job.outputPath}</div>}
    </li>
  )
}

export function ExportDialog() {
  const { open, jobs, info, settings, nameTouched, preparing, error } = useExportStore(
    useShallow((s) => ({ open: s.open, jobs: s.jobs, info: s.info, settings: s.settings, nameTouched: s.nameTouched, preparing: s.preparing, error: s.error }))
  )
  const patch = useExportStore((s) => s.patch)
  const set = useExportStore((s) => s.set)
  const project = useProjectStore((s) => s.project)
  const presets = useAutomationStore((s) => s.data?.presets ?? [])
  const openBatch = useAutomationStore((s) => s.patch)
  const [presetName, setPresetName] = useState('')

  useEffect(() => {
    if (!open) return
    void loadExportInfo()
    if (!nameTouched && project) set({ fileName: project.name })
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && patch({ open: false })
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open || !project) return null
  const end = timelineEnd(project)
  const size = outputSize(project.settings, settings.resolution)
  const busy = preparing !== null
  const canStart = !busy && end > 0 && settings.fileName.trim().length > 0 && (settings.outputDir === 'project' || !!info?.customFolder)

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Export video" onMouseDown={(e) => e.target === e.currentTarget && patch({ open: false })}>
      <div className="flex max-h-[90vh] w-[760px] max-w-full flex-col overflow-hidden rounded-lg border border-ink-600 bg-ink-800 shadow-2xl">
        <div className="flex items-center border-b border-ink-950 px-4 py-3">
          <h2 className="flex-1 text-base font-semibold">Export video</h2>
          <button className="icon-btn" aria-label="Close" onClick={() => patch({ open: false })}><X size={16} /></button>
        </div>

        <div className="flex flex-col gap-5 overflow-auto p-4">
          <section className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-[14rem] flex-1 flex-col gap-1">
              <span className="text-ink-300">Preset</span>
              <select className="field" value="" onChange={(e) => { const p = [...BUILTIN_PRESETS, ...presets].find((x) => x.id === e.target.value); if (p) set(presetToSettings(settings, p)) }}>
                <option value="">Apply a preset…</option>
                {[...BUILTIN_PRESETS, ...presets].map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <input className="field w-40" placeholder="Name to save as" maxLength={60} value={presetName} onChange={(e) => setPresetName(e.target.value)} />
            <button className="btn" disabled={!presetName.trim()} title="Save the resolution, quality and encoder below as a preset" onClick={() => { void savePreset(presetName); setPresetName('') }}>Save preset</button>
            <button className="btn" onClick={() => openBatch({ batchOpen: true })}>Batch export…</button>
          </section>
          <section className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-ink-300">Resolution</span>
              <select className="field" value={settings.resolution} onChange={(e) => set({ resolution: e.target.value as ExportSettings['resolution'] })}>
                {RESOLUTIONS.map((r) => {
                  const s = outputSize(project.settings, r)
                  return <option key={r} value={r}>{r === 'project' ? `Same as project (${s.width}×${s.height})` : `${r} (${s.width}×${s.height})`}</option>
                })}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-ink-300">Quality</span>
              <select className="field" value={settings.quality} onChange={(e) => set({ quality: e.target.value as ExportSettings['quality'] })}>
                {(Object.keys(QUALITY_PRESETS) as ExportSettings['quality'][]).map((q) => <option key={q} value={q}>{QUALITY_PRESETS[q].label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-ink-300">Encoder</span>
              <select className="field" value={settings.encoder} onChange={(e) => set({ encoder: e.target.value as ExportSettings['encoder'] })}>
                <option value="auto">Automatic (GPU when available)</option>
                <option value="cpu">CPU (most compatible)</option>
                <option value="nvenc">NVIDIA GPU (NVENC)</option>
              </select>
              <span className="text-ink-300">{info ? (info.nvenc ? 'An NVIDIA encoder was found on this computer.' : 'No NVIDIA encoder found. The CPU will be used.') : 'Checking…'}</span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-ink-300">File name</span>
              <div className="flex items-center gap-1">
                <input className="field" value={settings.fileName} maxLength={100} onChange={(e) => { patch({ nameTouched: true }); set({ fileName: e.target.value }) }} />
                <span className="text-ink-300">.mp4</span>
              </div>
            </label>
            <div className="col-span-2 flex flex-col gap-2">
              <span className="text-ink-300">Save to</span>
              <label className="flex items-center gap-2">
                <input type="radio" name="out" checked={settings.outputDir === 'project'} onChange={() => set({ outputDir: 'project' })} className="accent-[#2f7bff]" />
                <span>Project exports folder</span><span className="min-w-0 truncate text-ink-300" title={info?.projectFolder ?? ''}>{info?.projectFolder}</span>
              </label>
              <div className="flex items-center gap-2">
                <input type="radio" name="out" aria-label="Custom folder" checked={settings.outputDir === 'custom'} disabled={!info?.customFolder} onChange={() => set({ outputDir: 'custom' })} className="accent-[#2f7bff]" />
                <button className="btn h-7 px-2 text-xs" onClick={() => void chooseOutputFolder()}><FolderOpen size={13} />Choose folder…</button>
                <span className="min-w-0 truncate text-ink-300" title={info?.customFolder ?? ''}>{info?.customFolder ?? 'No folder chosen'}</span>
              </div>
            </div>
          </section>

          <section className="flex flex-wrap items-center gap-3">
            <span className="text-ink-300">
              {size.width}×{size.height} · {project.settings.fps} fps · H.264 + AAC · {framesToTimecode(end, project.settings.fps)} long
            </span>
            <button className="btn btn-primary ml-auto" disabled={!canStart} onClick={() => void queueExport()}>
              {busy ? <><Loader2 size={14} className="animate-spin" />{preparing}</> : 'Add to export queue'}
            </button>
          </section>
          {end === 0 && <p className="-mt-3 text-amber-200">The timeline is empty. Add clips or subtitles first.</p>}
          {error && <div role="alert" className="-mt-2 rounded-md border border-red-900 bg-red-950/60 p-2 text-red-200">{error}</div>}

          <section className="flex flex-col gap-2">
            <div className="flex items-center">
              <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-ink-300">Export queue</h3>
              <button className="btn h-7 px-2 text-xs" disabled={jobs.every(isActive)} onClick={() => void window.r0bi?.export.clearFinished()}>Clear finished</button>
            </div>
            {jobs.length === 0 ? (
              <div className="rounded-md border border-dashed border-ink-600 p-4 text-center text-ink-300">Nothing exported yet.</div>
            ) : (
              <ul className="flex flex-col gap-2">{[...jobs].reverse().map((j) => <Job key={j.id} job={j} />)}</ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
