import { useRef } from 'react'
import { FilePlus2, FolderOpen, Redo2, Save, SaveAll, Settings, Undo2, Upload } from 'lucide-react'
import { editProject, useProjectStore } from '../store/projectStore'
import { isActive, useExportStore } from '../store/exportStore'
import { useAiStore } from '../store/aiStore'
import { timelineEnd } from '@shared/timeline'
import { openProject, saveProject, saveProjectAs } from '../lib/actions'
import { Logo } from './Logo'

function statusText(status: string, autosavedAt: number | null): string {
  if (status === 'saving') return 'Saving…'
  if (status === 'error') return 'Save failed'
  if (status === 'dirty') {
    return autosavedAt
      ? `Unsaved changes · autosaved ${new Date(autosavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'Unsaved changes'
  }
  return 'All changes saved'
}

export function TopBar({ onNew }: { onNew(): void }) {
  const { project, status, autosavedAt, past, future, undo, redo } = useProjectStore()
  const nameRef = useRef<HTMLInputElement>(null)
  const activeJob = useExportStore((s) => s.jobs.find(isActive))
  const openExport = useExportStore((s) => s.patch)
  const openSettings = useAiStore((s) => s.patch)
  const canExport = !!project && timelineEnd(project) > 0

  const commitName = () => {
    const el = nameRef.current
    if (!el || !project) return
    const next = el.value.trim()
    if (next && next !== project.name) editProject.rename(next)
    else el.value = project.name
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-ink-950 bg-ink-800 px-3">
      <div className="flex items-center gap-2">
        <Logo />
        <span className="font-semibold tracking-tight">R0-BI Studio</span>
      </div>
      <div className="mx-1 h-5 w-px bg-ink-600" />
      <button className="icon-btn" title="New project (Ctrl+N)" onClick={onNew}><FilePlus2 size={17} /></button>
      <button className="icon-btn" title="Open project (Ctrl+O)" onClick={() => void openProject()}><FolderOpen size={17} /></button>
      <button className="icon-btn" title="Save (Ctrl+S)" disabled={!project} onClick={() => void saveProject()}><Save size={17} /></button>
      <button className="icon-btn" title="Save a copy to a new folder" disabled={!project} onClick={() => void saveProjectAs()}><SaveAll size={17} /></button>

      <div className="mx-auto flex min-w-0 flex-col items-center leading-tight">
        {project ? (
          <>
            <input
              ref={nameRef}
              key={project.id + project.name}
              defaultValue={project.name}
              aria-label="Project name"
              maxLength={80}
              onBlur={commitName}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              className="w-64 truncate rounded bg-transparent px-2 text-center font-medium hover:bg-ink-700 focus:bg-ink-900"
            />
            <span className={`text-[11px] ${status === 'error' ? 'text-red-400' : 'text-ink-300'}`}>{statusText(status, autosavedAt)}</span>
          </>
        ) : (
          <span className="text-ink-300">No project open</span>
        )}
      </div>

      <button className="icon-btn" title="Undo (Ctrl+Z)" disabled={past.length === 0} onClick={undo}><Undo2 size={17} /></button>
      <button className="icon-btn" title="Redo (Ctrl+Shift+Z)" disabled={future.length === 0} onClick={redo}><Redo2 size={17} /></button>
      <div className="mx-1 h-5 w-px bg-ink-600" />
      <button className="icon-btn" title="Settings" onClick={() => openSettings({ settingsOpen: true })}><Settings size={17} /></button>
      <button className="btn btn-primary" title={canExport ? 'Export video (Ctrl+E)' : 'Add clips or subtitles to export'} disabled={!project} onClick={() => openExport({ open: true })}>
        <Upload size={15} />{activeJob ? `Exporting ${Math.round(activeJob.progress * 100)}%` : 'Export'}
      </button>
    </header>
  )
}
