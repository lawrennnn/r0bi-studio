import { applyTemplate, assembleScenes, batchFileName, captureScene, captureTemplate, insertScene, presetToSettings, refKey, sceneMedia, type Preset, type Scene, type Template } from '@shared/automation'
import type { AutomationKind } from '@shared/api'
import type { MediaAsset, Project } from '@shared/project'
import { timelineEnd } from '@shared/timeline'
import { useProjectStore } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'
import { useMediaStore } from '../store/mediaStore'
import { useExportStore } from '../store/exportStore'
import { useAutomationStore } from '../store/automationStore'
import { createProject } from './actions'
import { enqueueProject } from './exportActions'

const auto = () => useAutomationStore.getState()
const NO_BRIDGE = 'Automation needs the desktop app. Start it with "npm run dev".'
const say = (notice: string | null) => auto().patch({ notice })
const newId = () => crypto.randomUUID()

/** Where a library item's file is, as a full path (project-relative paths are joined to the project folder). */
export function absolutePath(dir: string | null, a: Pick<MediaAsset, 'path' | 'pathKind'>): string {
  return a.pathKind === 'absolute' || !dir ? a.path : `${dir.replace(/[\\/]+$/, '')}/${a.path}`
}

export async function loadAutomation(): Promise<void> {
  const res = await window.r0bi?.automation.load()
  if (res?.ok) auto().patch({ data: res.data })
}

async function save(kind: AutomationKind, item: unknown, ok: string): Promise<boolean> {
  const res = await window.r0bi?.automation.save(kind, item)
  if (!res) {
    say(NO_BRIDGE)
    return false
  }
  if (!res.ok) {
    say(res.error)
    return false
  }
  auto().patch({ data: res.data })
  say(ok)
  return true
}

export async function removeItem(kind: AutomationKind, id: string): Promise<void> {
  const res = await window.r0bi?.automation.remove(kind, id)
  if (res?.ok) auto().patch({ data: res.data })
  else if (res) say(res.error)
}

// ---- Templates -------------------------------------------------------------------------------

export async function saveTemplate(name: string, description: string): Promise<void> {
  const project = useProjectStore.getState().project
  if (!project || !name.trim()) return
  const t = captureTemplate(project, { id: newId(), name, description }, useExportStore.getState().settings, auto().recipe)
  await save('templates', t, `Saved template "${t.name}".`)
}

/** Apply a template to the open project (adds tracks, styles, levels; never touches clips). One undo step. */
export function applyTemplateToProject(t: Template): void {
  const project = useProjectStore.getState().project
  if (!project) return
  const r = applyTemplate(project, t)
  useProjectStore.getState().commit((d) => {
    d.settings = r.settings
    d.tracks = r.tracks
  })
  useExportStore.getState().set(t.exportSettings)
  auto().patch({ recipe: t.recipe })
  say(`Applied "${t.name}". ${r.report.join('. ')}.`)
}

export async function newProjectFromTemplate(t: Template, name: string): Promise<void> {
  const before = useProjectStore.getState().project?.id
  await createProject(name.trim() || t.name)
  const after = useProjectStore.getState().project
  if (!after || after.id === before) return // cancelled
  applyTemplateToProject(t)
}

// ---- Scenes ----------------------------------------------------------------------------------

export async function saveScene(name: string, startSeconds: number, endSeconds: number): Promise<void> {
  const { project, dir } = useProjectStore.getState()
  if (!project || !name.trim()) return
  const fps = project.settings.fps
  const r = captureScene(project, { id: newId(), name, startFrame: Math.round(startSeconds * fps), endFrame: Math.round(endSeconds * fps) }, (a) => absolutePath(dir, a))
  if (!r.ok) return say(r.error)
  await save('scenes', r.scene, `Saved scene "${r.scene.name}" (${r.scene.clips.length} clips).`)
}

/**
 * Put a saved scene on the timeline. Media the project does not have yet is imported first; the
 * import and the placement are a single undo step.
 */
export async function insertSceneAtPlayhead(scene: Scene): Promise<void> {
  const api = window.r0bi
  const { project, dir } = useProjectStore.getState()
  if (!api) return say(NO_BRIDGE)
  if (!project) return
  auto().patch({ busy: true, notice: null })
  try {
    const have = new Map(project.media.map((a) => [refKey(absolutePath(dir, a)), a]))
    const need = sceneMedia(scene).filter((m) => !have.has(refKey(m.path)))
    let added: MediaAsset[] = []
    let thumbs: Record<string, string> = {}
    const problems: string[] = []
    if (need.length > 0) {
      const res = await api.media.importPaths(need.map((m) => m.path), project.media.map(({ path, pathKind }) => ({ path, pathKind })))
      if (!res.ok) return say(res.error)
      added = res.data.assets
      thumbs = res.data.thumbs
      problems.push(...res.data.failures.map((f) => `${f.name}: ${f.error}`))
      for (const a of added) have.set(refKey(absolutePath(dir, a)), a)
    }
    const withMedia: Project = { ...project, media: [...project.media, ...added] }
    const r = insertScene(withMedia, scene, useUiStore.getState().playhead, (ref) => have.get(refKey(ref.path)) ?? null)
    if (!r.ok) return say(`${r.error}${problems.length ? `. ${problems.join('; ')}` : ''}`)
    useProjectStore.getState().commit((d) => {
      d.media = withMedia.media
      d.tracks = r.tracks
      d.clips = r.clips
      d.subtitles = r.subtitles
    })
    if (added.length > 0) useMediaStore.getState().patch({ thumbs: { ...useMediaStore.getState().thumbs, ...thumbs } })
    say(`Inserted "${scene.name}". ${r.report.join('. ')}${added.length ? `. Imported ${added.length} file${added.length === 1 ? '' : 's'}` : ''}.`)
  } finally {
    auto().patch({ busy: false })
  }
}

// ---- Assembly --------------------------------------------------------------------------------

export function assembleNow(): boolean {
  const project = useProjectStore.getState().project
  const a = auto()
  if (!project) return false
  const r = assembleScenes(project, { sceneAssetIds: a.sceneIds, narrationAssetId: a.narrationId, musicAssetId: a.musicId, mode: a.mode }, a.recipe)
  if (!r.ok) {
    say(r.error)
    return false
  }
  useProjectStore.getState().commit((d) => {
    d.tracks = r.tracks
    d.clips = r.clips
  })
  useUiStore.getState().patch({ selectedClipId: null, selectedCueId: null, playhead: 0 })
  say(`Assembled ${r.report.sceneCount} scene${r.report.sceneCount === 1 ? '' : 's'}, ${r.report.totalSeconds.toFixed(1)} s long. ${r.report.notes.join('. ')}${r.report.notes.length ? '.' : ''} Ctrl+Z undoes it.`)
  return true
}

// ---- Export presets and batch export ----------------------------------------------------------

export async function savePreset(name: string): Promise<void> {
  const s = useExportStore.getState().settings
  if (!name.trim()) return
  const p: Preset = { id: newId(), name: name.trim(), resolution: s.resolution, quality: s.quality, encoder: s.encoder, suffix: name.trim().slice(0, 40) }
  await save('presets', p, `Saved preset "${p.name}".`)
}

export async function pickBatchProjects(): Promise<void> {
  const res = await window.r0bi?.automation.pickProjects()
  if (!res) return
  if (res.ok) {
    const existing = auto().batchProjects
    const known = new Set(existing.map((p) => p.folder))
    auto().patch({ batchProjects: [...existing, ...res.data.filter((p) => !known.has(p.folder))] })
  } else if (!res.cancelled) say(res.error)
}

/** One export per project per preset, queued one after another. Returns how many were queued. */
export async function queueBatch(
  items: { project: Project; token?: string }[],
  presets: Preset[],
  onStatus: (text: string) => void
): Promise<{ queued: number; failed: string[] }> {
  const base = useExportStore.getState().settings
  let queued = 0
  const failed: string[] = []
  for (const it of items) {
    for (const preset of presets) {
      const label = `${it.project.name} / ${preset.name}`
      try {
        onStatus(label)
        await enqueueProject(it.project, { ...presetToSettings(base, preset), fileName: batchFileName(it.project.name, preset), outputDir: base.outputDir }, it.token, (t) => onStatus(`${label}: ${t}`))
        queued++
      } catch (e) {
        failed.push(`${label}: ${e instanceof Error ? e.message : 'failed'}`)
      }
    }
  }
  return { queued, failed }
}

export const timelineSeconds = (p: Project): number => timelineEnd(p) / p.settings.fps
