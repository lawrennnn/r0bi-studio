import { cuesToFrames, parseSrt } from '@shared/srt'
import { useProjectStore, editProject } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'
import { useMediaStore } from '../store/mediaStore'
import { subtitles } from '../store/subtitleActions'

/**
 * Import an .srt file into an empty subtitle track (creating one if needed), so an import
 * can never overwrite subtitles you already have.
 */
export async function importSrt(): Promise<void> {
  const say = (notice: string | null) => useMediaStore.getState().patch({ notice })
  const api = window.r0bi
  const project = useProjectStore.getState().project
  if (!api || !project) return say('Open a project first')
  const res = await api.subtitles.importDialog()
  if (!res.ok) return res.cancelled ? undefined : say(res.error)

  const { cues, warnings } = parseSrt(res.data.text)
  if (cues.length === 0) return say(`No subtitles found in ${res.data.name}${warnings[0] ? `. ${warnings[0]}` : ''}`)
  const frames = cuesToFrames(cues, project.settings.fps)

  let current = useProjectStore.getState().project!
  let track = current.tracks.find((t) => t.kind === 'subtitle' && !t.locked && !current.subtitles.some((c) => c.trackId === t.id))
  if (!track) {
    editProject.addTrack('subtitle')
    current = useProjectStore.getState().project!
    track = current.tracks.filter((t) => t.kind === 'subtitle').at(-1)
  }
  if (!track) return say('Could not create a subtitle track')

  const { added, skipped } = subtitles.importCues(track.id, frames)
  useUiStore.getState().patch({ subtitleTrackId: track.id, leftTab: 'subtitles', leftCollapsed: false })
  const extra = [skipped ? `${skipped} skipped (overlap)` : '', warnings.length ? `${warnings.length} problem${warnings.length === 1 ? '' : 's'} in the file` : ''].filter(Boolean)
  say(`Imported ${added} subtitle${added === 1 ? '' : 's'} from ${res.data.name} into ${track.name}${extra.length ? ` (${extra.join(', ')})` : ''}.`)
}
