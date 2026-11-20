import { Volume2, VolumeX } from 'lucide-react'
import { framesToTimecode } from '@shared/time'
import { editProject, useProjectStore } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'
import { timeline } from '../store/timelineActions'
import { Empty, NumField, Section, Slider } from './fields'

function Mixer() {
  const tracks = useProjectStore((s) => s.project?.tracks.filter((t) => t.kind === 'audio' || t.kind === 'video') ?? [])
  if (tracks.length === 0) return null
  return (
    <Section title="Mixer">
      <p className="text-ink-300">Track levels, 0 to 100%. Boosting above 100% is not supported yet.</p>
      {tracks.map((t) => (
        <div key={t.id} className="flex items-center gap-2">
          <button className="icon-btn icon-btn-sm shrink-0" title={t.muted ? 'Unmute track' : 'Mute track'} aria-pressed={t.muted} onClick={() => editProject.toggleTrack(t.id, 'muted')}>
            {t.muted ? <VolumeX size={14} className="text-accent" /> : <Volume2 size={14} />}
          </button>
          <span className="w-16 shrink-0 truncate" title={t.name}>{t.name}</span>
          <input type="range" min={0} max={100} value={t.volume} aria-label={`${t.name} level`} onChange={(e) => timeline.setTrackVolume(t.id, Number(e.target.value))} className="min-w-0 flex-1 accent-[#2f7bff]" />
          <span className="w-9 shrink-0 text-right tabular-nums">{t.volume}%</span>
        </div>
      ))}
    </Section>
  )
}

export function AudioPanel() {
  const project = useProjectStore((s) => s.project)
  const selectedId = useUiStore((s) => s.selectedClipId)
  if (!project) return <Empty>Open or create a project to adjust audio.</Empty>
  const clip = project.clips.find((c) => c.id === selectedId)
  const asset = project.media.find((a) => a.id === clip?.assetId)
  const track = project.tracks.find((t) => t.id === clip?.trackId)
  const fps = project.settings.fps
  const hasSound = !!clip && !!asset && asset.kind !== 'image' && !!asset.audioCodec
  const locked = !!track?.locked

  return (
    <div className="flex flex-col gap-4">
      <Section title="Selected clip">
        {!clip || !asset ? (
          <Empty>Select an audio or video clip on the timeline to set its volume and fades.</Empty>
        ) : !hasSound ? (
          <Empty>{asset.name} has no sound.</Empty>
        ) : (
          <>
            <div className="truncate font-medium" title={asset.name}>{asset.name}</div>
            <Slider label="Volume" value={clip.volume} disabled={locked} onChange={(v) => timeline.setVolume(clip.id, v)} />
            <NumField label="Fade in (frames)" value={clip.fadeInFrames} hint={`${(clip.fadeInFrames / fps).toFixed(2)} s`} disabled={locked} onCommit={(n) => timeline.setFade(clip.id, 'in', n)} />
            <NumField label="Fade out (frames)" value={clip.fadeOutFrames} hint={`${(clip.fadeOutFrames / fps).toFixed(2)} s`} disabled={locked} onCommit={(n) => timeline.setFade(clip.id, 'out', n)} />
            <p className="text-ink-300">Clip length {framesToTimecode(clip.durationFrames, fps)}. Fades are drawn as dark ramps on the clip.</p>
          </>
        )}
      </Section>
      <Mixer />
    </div>
  )
}
