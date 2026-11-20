import { useProjectStore } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'

const NO_BRIDGE = 'R0-BI Studio must run in the desktop app. Start it with "npm run dev".'

function confirmDiscard(): boolean {
  const { status } = useProjectStore.getState()
  return status !== 'dirty' && status !== 'error'
    ? true
    : window.confirm('You have unsaved changes. Continue without saving?')
}

export async function createProject(name: string): Promise<void> {
  const s = useProjectStore.getState()
  if (!window.r0bi) return s.setError(NO_BRIDGE)
  if (!confirmDiscard()) return
  const res = await window.r0bi.project.create(name)
  if (!res.ok) return res.cancelled ? undefined : s.setError(res.error)
  useProjectStore.getState().load(res.data.project, res.data.dir)
  useUiStore.getState().patch({ playhead: 0 })
}

export async function openProject(): Promise<void> {
  const s = useProjectStore.getState()
  if (!window.r0bi) return s.setError(NO_BRIDGE)
  if (!confirmDiscard()) return
  const res = await window.r0bi.project.open()
  if (!res.ok) return res.cancelled ? undefined : s.setError(res.error)
  useProjectStore.getState().load(res.data.project, res.data.dir, { dirty: res.data.recovered })
  useUiStore.getState().patch({ playhead: 0 })
}

export async function saveProject(): Promise<void> {
  const s = useProjectStore.getState()
  if (!s.project || s.status === 'saving') return
  if (!window.r0bi) return s.setError(NO_BRIDGE)
  const revision = s.revision
  s.setStatus('saving')
  const res = await window.r0bi.project.save(s.project)
  const after = useProjectStore.getState()
  if (!res.ok) {
    after.setStatus('error')
    return after.setError(res.error)
  }
  after.setError(null)
  after.markSaved(res.data, revision)
}

export async function saveProjectAs(): Promise<void> {
  const s = useProjectStore.getState()
  if (!s.project) return
  if (!window.r0bi) return s.setError(NO_BRIDGE)
  const revision = s.revision
  const res = await window.r0bi.project.saveAs(s.project)
  if (!res.ok) return res.cancelled ? undefined : s.setError(res.error)
  const after = useProjectStore.getState()
  after.setDir(res.data.dir)
  after.setError(null)
  after.markSaved(res.data.project, revision)
}

export async function autosaveProject(): Promise<void> {
  const s = useProjectStore.getState()
  if (!s.project || !window.r0bi || s.status !== 'dirty') return
  const res = await window.r0bi.project.autosave(s.project)
  if (res.ok) useProjectStore.getState().setAutosaved(Date.now())
}
