import type { Project } from '@shared/project'
import { outputSize, type ExportSettings } from '@shared/render'
import { useProjectStore } from '../store/projectStore'
import { useExportStore } from '../store/exportStore'
import { subtitleStyleOf } from '../store/subtitleActions'
import { SubtitleRasterizer } from './subtitleRaster'

const store = () => useExportStore.getState()
const NO_BRIDGE = 'Exporting needs the desktop app. Start it with "npm run dev".'

export async function loadExportInfo(): Promise<void> {
  const res = await window.r0bi?.export.info()
  if (res?.ok) store().patch({ info: res.data })
}

export async function chooseOutputFolder(): Promise<void> {
  const res = await window.r0bi?.export.chooseFolder()
  if (!res) return
  if (res.ok) {
    store().set({ outputDir: 'custom' })
    await loadExportInfo()
  } else if (!res.cancelled) store().patch({ error: res.error })
}

/**
 * Draw the subtitle images, hand them to the main process, and add one export to the queue.
 * Subtitles are drawn here (not by FFmpeg) so the video matches the preview and Khmer text shapes correctly.
 * `projectToken` is set for projects picked for batch export (the main process knows their folders).
 */
export async function enqueueProject(project: Project, settings: ExportSettings, projectToken?: string, onStatus?: (text: string) => void): Promise<void> {
  const api = window.r0bi
  if (!api) throw new Error(NO_BRIDGE)
  onStatus?.('Preparing…')
  const prep = await api.export.prepare()
  if (!prep.ok) throw new Error(prep.error)

  const size = outputSize(project.settings, settings.resolution)
  const scale = size.height / project.settings.height
  const raster = new SubtitleRasterizer(size.width, size.height)

  // One image per distinct (track, text); repeated lines share a file.
  const jobs: { key: string; text: string; trackId: string }[] = []
  const cueImages: Record<string, string> = {}
  const byText = new Map<string, string>()
  for (const t of project.tracks.filter((x) => x.kind === 'subtitle' && x.visible)) {
    for (const cue of project.subtitles.filter((c) => c.trackId === t.id && c.text.trim())) {
      const id = `${t.id}\u0000${cue.text}`
      let key = byText.get(id)
      if (!key) {
        key = `img${byText.size}`
        byText.set(id, key)
        jobs.push({ key, text: cue.text, trackId: t.id })
      }
      cueImages[cue.id] = key
    }
  }

  const batch: { key: string; data: string }[] = []
  const flush = async () => {
    if (batch.length === 0) return
    const res = await api.export.subtitleImages(prep.data.prepId, batch.splice(0))
    if (!res.ok) throw new Error(res.error)
  }
  if (jobs.length > 0) batch.push({ key: 'blank', data: await raster.blank() })
  for (const [i, j] of jobs.entries()) {
    onStatus?.(`Preparing subtitles ${i + 1}/${jobs.length}`)
    const style = subtitleStyleOf(project.tracks.find((t) => t.id === j.trackId))
    batch.push({ key: j.key, data: await raster.subtitle(j.text, style, scale) })
    if (batch.length >= 8) await flush()
    if (i % 4 === 3) await new Promise((r) => setTimeout(r)) // let the UI breathe
  }
  await flush()

  onStatus?.('Adding to the queue…')
  const res = await api.export.enqueue(prep.data.prepId, project, settings, cueImages, projectToken)
  if (!res.ok) throw new Error(res.error)
}

/** Export the open project with the dialog's settings. */
export async function queueExport(): Promise<void> {
  const project = useProjectStore.getState().project
  if (!window.r0bi) return store().patch({ error: NO_BRIDGE })
  if (!project) return
  store().patch({ error: null, preparing: 'Preparing…' })
  try {
    await enqueueProject(project, store().settings, undefined, (text) => store().patch({ preparing: text }))
  } catch (e) {
    store().patch({ error: e instanceof Error ? e.message : 'Could not start the export' })
  } finally {
    store().patch({ preparing: null })
  }
}
