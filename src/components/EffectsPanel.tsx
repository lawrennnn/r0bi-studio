import { useState } from 'react'
import { EFFECT_PRESETS, effectsOf, hasEffects } from '@shared/effects'
import { clipEnd, clipsOnTrack } from '@shared/timeline'
import { useProjectStore } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'
import { timeline } from '../store/timelineActions'
import { Section, Slider } from './fields'

export function EffectsPanel() {
  const project = useProjectStore((s) => s.project)
  const selectedId = useUiStore((s) => s.selectedClipId)
  const [message, setMessage] = useState<string | null>(null)
  const clip = project?.clips.find((c) => c.id === selectedId)
  const asset = project?.media.find((a) => a.id === clip?.assetId)
  const track = project?.tracks.find((t) => t.id === clip?.trackId)

  if (!project) return null
  const picture = !!clip && !!asset && !!track && asset.kind !== 'audio' && track.kind !== 'audio'
  if (!clip || !picture || !track) {
    return (
      <div className="flex flex-1 flex-col gap-3">
        <h2 className="panel-title">Effects</h2>
        <div className="rounded-md border border-dashed border-ink-600 p-4 text-center text-ink-300">
          {clip ? 'Audio clips have no picture. Use the Audio tab for sound.' : 'Select a video or image clip on the timeline, then pick an effect here.'}
        </div>
        <ul className="list-disc space-y-1 pl-5 text-ink-300">
          <li>Opacity, zoom (Ken Burns) and position moves</li>
          <li>Fade from or to black</li>
          <li>Dissolve into the next clip</li>
        </ul>
      </div>
    )
  }

  const fps = project.settings.fps
  const fx = effectsOf(clip)
  const locked = track.locked
  const set = (patch: Parameters<typeof timeline.setEffects>[1]) => timeline.setEffects(clip.id, patch)
  const next = clipsOnTrack(project.clips, clip.trackId, clip.id).find((c) => c.startFrame >= clipEnd(clip))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto pr-1">
      <h2 className="panel-title">Effects</h2>
      <div className="truncate font-medium" title={asset?.name}>{asset?.name}</div>

      <Section title="Quick moves">
        <div className="grid grid-cols-2 gap-1.5">
          {EFFECT_PRESETS.map((p) => (
            <button key={p.id} className="btn h-8 justify-center px-1 text-xs" disabled={locked} onClick={() => timeline.applyEffectPreset(clip.id, p.id)}>{p.label}</button>
          ))}
        </div>
        <button className="btn h-8 justify-center text-xs" disabled={locked || !hasEffects(clip)} onClick={() => timeline.resetEffects(clip.id)}>Remove all effects</button>
      </Section>

      <Section title="Opacity">
        <Slider label="Opacity" value={fx.opacity} disabled={locked} onChange={(v) => set({ opacity: v })} />
      </Section>

      <Section title="Zoom (from the first frame to the last)">
        <Slider label="Start" value={fx.scaleStart} min={100} max={400} disabled={locked} onChange={(v) => set({ scaleStart: v })} />
        <Slider label="End" value={fx.scaleEnd} min={100} max={400} disabled={locked} onChange={(v) => set({ scaleEnd: v })} />
      </Section>

      <Section title="Position (percent of the frame)">
        <Slider label="Start across" value={fx.posStartX} min={-100} max={100} unit="" disabled={locked} onChange={(v) => set({ posStartX: v })} />
        <Slider label="End across" value={fx.posEndX} min={-100} max={100} unit="" disabled={locked} onChange={(v) => set({ posEndX: v })} />
        <Slider label="Start up/down" value={fx.posStartY} min={-100} max={100} unit="" disabled={locked} onChange={(v) => set({ posStartY: v })} />
        <Slider label="End up/down" value={fx.posEndY} min={-100} max={100} unit="" disabled={locked} onChange={(v) => set({ posEndY: v })} />
        <p className="text-ink-300">Moving the picture off centre shows black (or the layer below) at the edges. Zoom in a little to avoid that.</p>
      </Section>

      <Section title="Fades and dissolve">
        <div className="flex flex-wrap gap-1.5">
          <button className="btn h-8 px-2 text-xs" disabled={locked} onClick={() => timeline.setVideoFade(clip.id, 'in', fps)}>Fade from black</button>
          <button className="btn h-8 px-2 text-xs" disabled={locked} onClick={() => timeline.setVideoFade(clip.id, 'out', fps)}>Fade to black</button>
          <button className="btn h-8 px-2 text-xs" disabled={locked || (!clip.videoFadeInFrames && !clip.videoFadeOutFrames)} onClick={() => { timeline.setVideoFade(clip.id, 'in', 0); timeline.setVideoFade(clip.id, 'out', 0) }}>Hard cut</button>
        </div>
        <button
          className="btn h-8 justify-center text-xs"
          disabled={locked || !next}
          title={next ? 'The next clip fades in over the end of this one' : 'There is no clip directly after this one'}
          onClick={() => { const r = timeline.dissolveIntoNext(clip.id, fps); setMessage(r.ok ? 'Dissolve added. The next clip moved up to a higher track so the two overlap.' : r.error) }}
        >Dissolve into next clip (1 s)</button>
        {message && <p role="status" className="text-ink-300">{message}</p>}
      </Section>
    </div>
  )
}
