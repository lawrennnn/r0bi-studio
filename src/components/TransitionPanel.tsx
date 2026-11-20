import { framesToTimecode } from '@shared/time'
import { clipEnd, clipsOnTrack } from '@shared/timeline'
import { useProjectStore } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'
import { timeline } from '../store/timelineActions'
import { Empty, NumField, Section } from './fields'

export function TransitionPanel() {
  const project = useProjectStore((s) => s.project)
  const selectedId = useUiStore((s) => s.selectedClipId)
  const clip = project?.clips.find((c) => c.id === selectedId)
  const asset = project?.media.find((a) => a.id === clip?.assetId)
  const track = project?.tracks.find((t) => t.id === clip?.trackId)
  if (!project || !clip || !asset || !track) return <Empty>Select a video or image clip on the timeline to add a fade.</Empty>
  if (asset.kind === 'audio' || track.kind === 'audio') return <Empty>Audio clips have no picture. Use the Audio tab for sound fades.</Empty>

  const fps = project.settings.fps
  const locked = track.locked
  const next = clipsOnTrack(project.clips, clip.trackId, clip.id).find((c) => c.startFrame >= clipEnd(clip))
  const tc = (f: number) => `${(f / fps).toFixed(2)} s`
  return (
    <div className="flex flex-col gap-4">
      <Section title="Picture fades">
        <div className="truncate font-medium" title={asset.name}>{asset.name}</div>
        <NumField label="Fade in (frames)" value={clip.videoFadeInFrames} hint={tc(clip.videoFadeInFrames)} disabled={locked} onCommit={(n) => timeline.setVideoFade(clip.id, 'in', n)} />
        <NumField label="Fade out (frames)" value={clip.videoFadeOutFrames} hint={tc(clip.videoFadeOutFrames)} disabled={locked} onCommit={(n) => timeline.setVideoFade(clip.id, 'out', n)} />
        <div className="flex flex-wrap gap-2">
          <button className="btn h-7 px-2 text-xs" disabled={locked} onClick={() => timeline.setVideoFade(clip.id, 'in', fps)}>Fade from black (1 s)</button>
          <button className="btn h-7 px-2 text-xs" disabled={locked} onClick={() => timeline.setVideoFade(clip.id, 'out', fps)}>Fade to black (1 s)</button>
          <button className="btn h-7 px-2 text-xs" disabled={locked || (!clip.videoFadeInFrames && !clip.videoFadeOutFrames)} onClick={() => { timeline.setVideoFade(clip.id, 'in', 0); timeline.setVideoFade(clip.id, 'out', 0) }}>Hard cut</button>
        </div>
      </Section>
      <Section title="Across a cut">
        {next ? (
          <>
            <p className="text-ink-300">Next clip on {track.name} starts at {framesToTimecode(next.startFrame, fps)}.</p>
            <button className="btn justify-center" disabled={locked} onClick={() => timeline.dipToBlack(clip.id, next.id, Math.round(fps / 2))}>Dip to black (0.5 s each side)</button>
          </>
        ) : (
          <p className="text-ink-300">There is no later clip on this track.</p>
        )}
        <p className="text-ink-300">To dissolve between two clips, put the second on a track above the first, overlap them, and fade the top clip in.</p>
      </Section>
    </div>
  )
}
