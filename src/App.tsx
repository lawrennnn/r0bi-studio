import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { TopBar } from './components/TopBar'
import { LeftSidebar } from './components/LeftSidebar'
import { Preview } from './components/Preview'
import { RightSidebar } from './components/RightSidebar'
import { Timeline } from './components/Timeline'
import { Welcome } from './components/Welcome'
import { ExportDialog } from './components/ExportDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { BatchDialog } from './components/BatchDialog'
import { loadAutomation } from './lib/automationActions'
import { useAutomationStore } from './store/automationStore'
import { useAiStore } from './store/aiStore'
import { loadAiStatus } from './lib/aiActions'
import { useExportStore } from './store/exportStore'
import { loadExportInfo } from './lib/exportActions'
import { Resizer } from './components/Resizer'
import { useProjectStore } from './store/projectStore'
import { useUiStore } from './store/uiStore'
import { autosaveProject, openProject, saveProject } from './lib/actions'
import { timeline } from './store/timelineActions'
import { subtitles } from './store/subtitleActions'
import { loadToolStatus, refreshMedia } from './lib/mediaActions'
import { libraryKey } from './lib/libraryKey'
import { pause, togglePlayback } from './lib/playback'
import { useMediaStore } from './store/mediaStore'

const AUTOSAVE_MS = 3000

export default function App() {
  const { project, status, revision, error, setError } = useProjectStore()
  const ui = useUiStore(
    useShallow((s) => ({
      leftWidth: s.leftWidth, rightWidth: s.rightWidth, timelineHeight: s.timelineHeight,
      leftCollapsed: s.leftCollapsed, rightCollapsed: s.rightCollapsed, patch: s.patch
    }))
  )
  const [creating, setCreating] = useState(false)

  // Tell the main process whether closing the window would lose changes.
  useEffect(() => {
    window.r0bi?.app.setDirty(status === 'dirty' || status === 'error')
  }, [status])

  // Media: check tools once, reset per project, and re-check files when the library changes
  // or the window regains focus (so moved/deleted files are noticed).
  const mediaKey = libraryKey(project)
  useEffect(() => { void loadToolStatus() }, [])
  useEffect(() => { useMediaStore.getState().reset(); useUiStore.getState().patch({ selectedClipId: null, selectedCueId: null, subtitleTrackId: null, playhead: 0 }); pause() }, [project?.id])
  useEffect(() => { void refreshMedia() }, [project?.id, mediaKey])
  useEffect(() => {
    const onFocus = () => void refreshMedia()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // A file dropped outside the library panel must never navigate the window to that file.
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  }, [])

  // AI assistant: key status once, and a fresh chat for each project.
  useEffect(() => { void loadAiStatus(); void loadAutomation() }, [])
  useEffect(() => { useAutomationStore.getState().patch({ sceneIds: [], narrationId: null, musicId: null, notice: null }) }, [project?.id])
  useEffect(() => { useAiStore.getState().reset() }, [project?.id])

  // Export queue: initial list and live updates from the main process.
  useEffect(() => {
    const api = window.r0bi
    if (!api) return
    void loadExportInfo()
    void api.export.list().then((r) => r.ok && useExportStore.getState().patch({ jobs: r.data }))
    return api.export.onUpdate((jobs) => useExportStore.getState().patch({ jobs }))
  }, [])

  // Debounced autosave to the project's backups folder.
  useEffect(() => {
    if (status !== 'dirty') return
    const t = window.setTimeout(() => void autosaveProject(), AUTOSAVE_MS)
    return () => window.clearTimeout(t)
  }, [status, revision])

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)
      const k = e.key.toLowerCase()
      const uiState = useUiStore.getState()
      if (e.ctrlKey || e.metaKey) {
        if (k === 's') { e.preventDefault(); void saveProject() }
        else if (k === 'o') { e.preventDefault(); void openProject() }
        else if (k === 'n') { e.preventDefault(); setCreating(true); useProjectStore.getState().close() }
        else if (!typing && k === 'z') { e.preventDefault(); e.shiftKey ? useProjectStore.getState().redo() : useProjectStore.getState().undo() }
        else if (k === 'e' && useProjectStore.getState().project) { e.preventDefault(); useExportStore.getState().patch({ open: true }) }
        else if (!typing && k === 'y') { e.preventDefault(); useProjectStore.getState().redo() }
        else if (!typing && k === 'd' && (uiState.selectedClipId || uiState.selectedCueId)) { e.preventDefault(); if (uiState.selectedClipId) timeline.duplicate(uiState.selectedClipId); else if (uiState.selectedCueId) subtitles.duplicate(uiState.selectedCueId) }
        return
      }
      if (e.altKey || !useProjectStore.getState().project) return
      if (e.key === ' ' && !(e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) {
        e.preventDefault()
        if (e.target instanceof HTMLButtonElement) e.target.blur() // so Space does not also click the focused button
        togglePlayback()
        return
      }
      if (typing) return
      const fps = useProjectStore.getState().project?.settings.fps ?? 30
      if (k === 's') { e.preventDefault(); timeline.split() }
      else if ((k === 'delete' || k === 'backspace') && (uiState.selectedClipId || uiState.selectedCueId)) { e.preventDefault(); if (uiState.selectedClipId) timeline.remove(uiState.selectedClipId); else if (uiState.selectedCueId) subtitles.remove(uiState.selectedCueId) }
      else if (k === 'arrowleft') { e.preventDefault(); uiState.patch({ playhead: Math.max(0, uiState.playhead - (e.shiftKey ? fps : 1)) }) }
      else if (k === 'arrowright') { e.preventDefault(); uiState.patch({ playhead: uiState.playhead + (e.shiftKey ? fps : 1) }) }
      else if (k === 'home') { e.preventDefault(); uiState.patch({ playhead: 0 }) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const startNew = () => {
    if (project && status === 'dirty' && !window.confirm('You have unsaved changes. Continue without saving?')) return
    useProjectStore.getState().close()
    setCreating(true)
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar onNew={startNew} />
      <ExportDialog />
      <SettingsDialog />
      <BatchDialog />
      {error && (
        <div role="alert" className="flex items-center gap-2 border-b border-red-900 bg-red-950/60 px-3 py-1.5 text-red-200">
          <span className="flex-1">{error}</span>
          <button className="icon-btn icon-btn-sm" aria-label="Dismiss error" onClick={() => setError(null)}><X size={14} /></button>
        </div>
      )}
      {!project ? (
        <Welcome creating={creating} onCancel={() => setCreating(false)} onStartNew={() => setCreating(true)} />
      ) : (
        <>
          <div className="flex min-h-0 flex-1">
            <div className="flex shrink-0" style={{ width: ui.leftCollapsed ? 48 : ui.leftWidth }}>
              <LeftSidebar hasProject />
            </div>
            {!ui.leftCollapsed && <Resizer axis="x" label="Resize library panel" size={ui.leftWidth} min={220} max={460} onChange={(leftWidth) => ui.patch({ leftWidth })} />}
            <Preview />
            {!ui.rightCollapsed && <Resizer axis="x" invert label="Resize properties panel" size={ui.rightWidth} min={240} max={480} onChange={(rightWidth) => ui.patch({ rightWidth })} />}
            <div className="flex shrink-0" style={{ width: ui.rightCollapsed ? 40 : ui.rightWidth }}>
              <RightSidebar />
            </div>
          </div>
          <Resizer axis="y" invert label="Resize timeline" size={ui.timelineHeight} min={160} max={520} onChange={(timelineHeight) => ui.patch({ timelineHeight })} />
          <div className="flex shrink-0" style={{ height: ui.timelineHeight }}>
            <Timeline />
          </div>
        </>
      )}
    </div>
  )
}
