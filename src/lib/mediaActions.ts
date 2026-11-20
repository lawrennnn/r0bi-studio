import type { ExistingRef, ImportResult } from '@shared/api'
import type { MediaAsset } from '@shared/project'
import { clampClipsToAsset } from '@shared/timeline'
import { useProjectStore } from '../store/projectStore'
import { useMediaStore } from '../store/mediaStore'
import { libraryKey } from './libraryKey'

const NO_BRIDGE = 'R0-BI Studio must run in the desktop app. Start it with "npm run dev".'
const media = () => useMediaStore.getState()
const project = () => useProjectStore.getState().project

const existingRefs = (): ExistingRef[] => (project()?.media ?? []).map(({ path, pathKind }) => ({ path, pathKind }))

function say(notice: string | null): void {
  media().patch({ notice })
}

export async function loadToolStatus(): Promise<void> {
  const res = await window.r0bi?.media.toolStatus()
  if (res?.ok) media().patch({ tools: res.data })
}

const waveformsRequested = new Set<string>()

/** Ask the main process for waveforms of audio files that do not have one yet. Fire and forget. */
async function loadWaveforms(assets: MediaAsset[]): Promise<void> {
  const need = assets.filter((a) => a.kind === 'audio' && !media().waveforms[a.id] && !waveformsRequested.has(a.id))
  if (need.length === 0 || !window.r0bi) return
  need.forEach((a) => waveformsRequested.add(a.id))
  const res = await window.r0bi.media.waveforms(need)
  need.forEach((a) => waveformsRequested.delete(a.id))
  if (!res.ok) return
  const decoded: Record<string, Uint8Array> = {}
  for (const [id, b64] of Object.entries(res.data)) {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    decoded[id] = bytes
  }
  media().patch({ waveforms: { ...media().waveforms, ...decoded } })
}

/** Re-check which files are missing and load any thumbnails we do not have yet. */
export async function refreshMedia(): Promise<void> {
  const p = project()
  if (!p || !window.r0bi) return
  const res = await window.r0bi.media.refresh(p.media, Object.keys(media().thumbs))
  if (!res.ok) return
  const missing: Record<string, true> = {}
  for (const id of res.data.missing) missing[id] = true
  media().patch({ missing, thumbs: { ...media().thumbs, ...res.data.thumbs }, registeredKey: libraryKey(p) })
  void loadWaveforms(p.media)
}

function applyImport(data: ImportResult): void {
  if (data.assets.length > 0) {
    useProjectStore.getState().commit((d) => void d.media.push(...data.assets))
    media().patch({ thumbs: { ...media().thumbs, ...data.thumbs }, selected: data.assets[0].id })
  }
  const parts: string[] = []
  if (data.assets.length > 0) parts.push(`Imported ${data.assets.length} file${data.assets.length === 1 ? '' : 's'}.`)
  if (data.failures.length > 0) {
    const shown = data.failures.slice(0, 3).map((f) => `${f.name}: ${f.error}`)
    const more = data.failures.length > 3 ? ` (+${data.failures.length - 3} more)` : ''
    parts.push(`Skipped ${shown.join('; ')}${more}`)
  }
  say(parts.join(' ') || null)
}

export async function importWithDialog(): Promise<void> {
  if (!window.r0bi) return say(NO_BRIDGE)
  media().patch({ importing: true, notice: null })
  try {
    const res = await window.r0bi.media.importDialog(existingRefs())
    if (!res.ok) return res.cancelled ? undefined : say(res.error)
    applyImport(res.data)
  } finally {
    media().patch({ importing: false })
  }
}

export async function importDropped(files: File[]): Promise<void> {
  const api = window.r0bi
  if (!api) return say(NO_BRIDGE)
  const paths = files.map((f) => api.media.getPathForFile(f)).filter((p) => p !== '')
  if (paths.length === 0) return say('Only files from your computer can be imported')
  media().patch({ importing: true, notice: null })
  try {
    const res = await api.media.importPaths(paths, existingRefs())
    if (!res.ok) return say(res.error)
    applyImport(res.data)
  } finally {
    media().patch({ importing: false })
  }
}

export function removeAsset(id: string): void {
  const used = (project()?.clips ?? []).filter((c) => c.assetId === id).length
  if (used > 0 && !window.confirm(`This item is used by ${used} clip${used === 1 ? '' : 's'} on the timeline. Removing it deletes ${used === 1 ? 'that clip' : 'those clips'} too. Continue?`)) return
  useProjectStore.getState().commit((d) => {
    d.media = d.media.filter((a) => a.id !== id)
    d.clips = d.clips.filter((c) => c.assetId !== id)
  })
  if (media().selected === id) media().patch({ selected: null })
}

export async function relinkAsset(asset: MediaAsset): Promise<void> {
  if (!window.r0bi) return say(NO_BRIDGE)
  media().setBusy(asset.id, 'relink')
  try {
    const res = await window.r0bi.media.relink(asset)
    if (!res.ok) return res.cancelled ? undefined : say(res.error)
    const { asset: updated, thumb, durationDiffers } = res.data
    useProjectStore.getState().commit((d) => {
      const i = d.media.findIndex((a) => a.id === asset.id)
      if (i >= 0) d.media[i] = updated
      // The replacement file may be shorter: keep clips inside the new source.
      d.clips = clampClipsToAsset(d.clips, updated, d.settings.fps)
    })
    if (thumb) media().patch({ thumbs: { ...media().thumbs, [asset.id]: thumb } })
    say(durationDiffers ? 'Relinked, but the new file has a different duration than the original.' : 'Relinked.')
    await refreshMedia()
  } finally {
    media().setBusy(asset.id, null)
  }
}

export async function makeProxy(asset: MediaAsset): Promise<void> {
  if (!window.r0bi) return say(NO_BRIDGE)
  media().setBusy(asset.id, 'proxy')
  say(null)
  try {
    const res = await window.r0bi.media.makeProxy(asset)
    if (!res.ok) return say(res.error)
    useProjectStore.getState().commit((d) => {
      const a = d.media.find((x) => x.id === asset.id)
      if (a) a.proxy = res.data.proxy
    })
    say(`Proxy ready for ${asset.name}.`)
  } finally {
    media().setBusy(asset.id, null)
  }
}

export async function cancelProxy(id: string): Promise<void> {
  await window.r0bi?.media.cancelProxy(id)
}
