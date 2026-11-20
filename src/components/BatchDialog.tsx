import { useEffect, useMemo, useState } from 'react'
import { FolderOpen, Loader2, X } from 'lucide-react'
import { BUILTIN_PRESETS, type Preset } from '@shared/automation'
import { useProjectStore } from '../store/projectStore'
import { useAutomationStore } from '../store/automationStore'
import { useExportStore } from '../store/exportStore'
import { chooseOutputFolder } from '../lib/exportActions'
import { pickBatchProjects, queueBatch } from '../lib/automationActions'

const CURRENT = 'current'

export function BatchDialog() {
  const open = useAutomationStore((s) => s.batchOpen)
  const picked = useAutomationStore((s) => s.batchProjects)
  const data = useAutomationStore((s) => s.data)
  const patch = useAutomationStore((s) => s.patch)
  const current = useProjectStore((s) => s.project)
  const settings = useExportStore((s) => s.settings)
  const info = useExportStore((s) => s.info)
  const setExport = useExportStore((s) => s.set)
  const exportPatch = useExportStore((s) => s.patch)
  const [projectKeys, setProjectKeys] = useState<Set<string>>(new Set([CURRENT]))
  const [presetIds, setPresetIds] = useState<Set<string>>(new Set([BUILTIN_PRESETS[0].id]))
  const [status, setStatus] = useState<string | null>(null)
  const [result, setResult] = useState<{ queued: number; failed: string[] } | null>(null)

  const presets: Preset[] = useMemo(() => [...BUILTIN_PRESETS, ...(data?.presets ?? [])], [data])

  useEffect(() => {
    if (!open) return
    setResult(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && patch({ batchOpen: false })
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, patch])

  if (!open) return null
  const toggle = <T,>(set: Set<T>, v: T, apply: (s: Set<T>) => void) => {
    const n = new Set(set)
    if (n.has(v)) n.delete(v)
    else n.add(v)
    apply(n)
  }
  const chosenProjects = [
    ...(current && projectKeys.has(CURRENT) ? [{ project: current, token: undefined as string | undefined }] : []),
    ...picked.filter((p) => projectKeys.has(p.token)).map((p) => ({ project: p.project, token: p.token as string | undefined }))
  ]
  const chosenPresets = presets.filter((p) => presetIds.has(p.id))
  const total = chosenProjects.length * chosenPresets.length
  const busy = status !== null
  const needsFolder = settings.outputDir === 'custom' && !info?.customFolder

  const run = async () => {
    setResult(null)
    setStatus('Starting…')
    try {
      setResult(await queueBatch(chosenProjects, chosenPresets, setStatus))
    } finally {
      setStatus(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[2050] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Batch export" onMouseDown={(e) => e.target === e.currentTarget && !busy && patch({ batchOpen: false })}>
      <div className="flex max-h-[90vh] w-[620px] max-w-full flex-col overflow-hidden rounded-lg border border-ink-600 bg-ink-800 shadow-2xl">
        <div className="flex items-center border-b border-ink-950 px-4 py-3">
          <h2 className="flex-1 text-base font-semibold">Batch export</h2>
          <button className="icon-btn" aria-label="Close" disabled={busy} onClick={() => patch({ batchOpen: false })}><X size={16} /></button>
        </div>
        <div className="flex flex-col gap-4 overflow-auto p-4">
          <section className="flex flex-col gap-2">
            <div className="flex items-center">
              <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-ink-300">Projects</h3>
              <button className="btn h-7 px-2 text-xs" disabled={busy} onClick={() => void pickBatchProjects()}><FolderOpen size={13} />Add other projects…</button>
            </div>
            {current && (
              <label className="flex items-center gap-2"><input type="checkbox" className="accent-[#2f7bff]" checked={projectKeys.has(CURRENT)} onChange={() => toggle(projectKeys, CURRENT, setProjectKeys)} />{current.name} <span className="text-ink-300">(open now)</span></label>
            )}
            {picked.map((p) => (
              <label key={p.token} className="flex items-center gap-2"><input type="checkbox" className="accent-[#2f7bff]" checked={projectKeys.has(p.token)} onChange={() => toggle(projectKeys, p.token, setProjectKeys)} /><span className="min-w-0 truncate">{p.name}</span><span className="min-w-0 truncate text-ink-300" title={p.folder}>{p.folder}</span></label>
            ))}
          </section>
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300">Presets</h3>
            {presets.map((p) => (
              <label key={p.id} className="flex items-center gap-2"><input type="checkbox" className="accent-[#2f7bff]" checked={presetIds.has(p.id)} onChange={() => toggle(presetIds, p.id, setPresetIds)} />{p.name}<span className="text-ink-300">{p.resolution} · {p.quality} · {p.encoder}</span></label>
            ))}
          </section>
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300">Save to</h3>
            <label className="flex items-center gap-2"><input type="radio" name="bout" className="accent-[#2f7bff]" checked={settings.outputDir === 'project'} onChange={() => setExport({ outputDir: 'project' })} />Each project's own exports folder</label>
            <div className="flex items-center gap-2">
              <input type="radio" name="bout" aria-label="Custom folder" className="accent-[#2f7bff]" checked={settings.outputDir === 'custom'} disabled={!info?.customFolder} onChange={() => setExport({ outputDir: 'custom' })} />
              <button className="btn h-7 px-2 text-xs" onClick={() => void chooseOutputFolder()}><FolderOpen size={13} />Choose folder…</button>
              <span className="min-w-0 truncate text-ink-300">{info?.customFolder ?? 'No folder chosen'}</span>
            </div>
          </section>
          <div className="flex items-center gap-3">
            <span className="text-ink-300">{total} export{total === 1 ? '' : 's'} will be added to the queue (each project × each preset). File names: "Project - preset".</span>
            <button className="btn btn-primary ml-auto shrink-0" disabled={busy || total === 0 || needsFolder} onClick={() => void run()}>
              {busy ? <><Loader2 size={14} className="animate-spin" />Working…</> : `Queue ${total} export${total === 1 ? '' : 's'}`}
            </button>
          </div>
          {status && <div className="text-ink-300">{status}</div>}
          {result && (
            <div role="status" className="rounded-md bg-ink-700 p-2">
              <div>{result.queued} export{result.queued === 1 ? '' : 's'} queued. Watch them in the Export window.</div>
              {result.failed.map((f, i) => <div key={i} className="mt-1 text-red-300">{f}</div>)}
              {result.queued > 0 && <button className="btn mt-2 h-7 px-2 text-xs" onClick={() => { patch({ batchOpen: false }); exportPatch({ open: true }) }}>Open the queue</button>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
