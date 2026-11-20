import { useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, SkipBack, StepBack, StepForward, Volume2, VolumeX, Zap } from 'lucide-react'
import { framesToTimecode } from '@shared/time'
import { timelineEnd } from '@shared/timeline'
import { computeLayers, previewUrl, sourceSeconds } from '@shared/preview'
import { clipOpacity, effectiveGain } from '@shared/audio'
import { effectsAt } from '@shared/effects'
import { subtitleBlockCss, subtitleBoxCss } from '../lib/subtitleStyle'
import { subtitleStyleOf } from '../store/subtitleActions'
import { useProjectStore } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'
import { useMediaStore } from '../store/mediaStore'
import { libraryKey } from '../lib/libraryKey'
import { togglePlayback } from '../lib/playback'

/** Largest box with the project's aspect ratio that fits the available area. */
function useFit(aspect: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const aw = Math.max(0, entry.contentRect.width - 32)
      const ah = Math.max(0, entry.contentRect.height - 32)
      const w = Math.min(aw, ah * aspect)
      setBox({ w, h: w / aspect })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [aspect])
  return { ref, box }
}

type MediaEl = HTMLVideoElement | HTMLAudioElement

/** Fade, opacity, zoom and position for one picture layer. Zoom is about the centre; position is a share of the frame. */
function layerLook(clip: Parameters<typeof clipOpacity>[0] & Parameters<typeof effectsAt>[0], frame: number): React.CSSProperties {
  const fx = effectsAt(clip, frame)
  const moved = fx.scale !== 1 || fx.x !== 0 || fx.y !== 0
  return { opacity: clipOpacity(clip, frame) * fx.opacity, ...(moved ? { transform: `translate(${fx.x}%, ${fx.y}%) scale(${fx.scale})` } : {}) }
}

export function Preview() {
  const project = useProjectStore((s) => s.project)
  const playhead = useUiStore((s) => s.playhead)
  const playing = useUiStore((s) => s.playing)
  const muted = useUiStore((s) => s.previewMuted)
  const useProxies = useUiStore((s) => s.useProxies)
  const patch = useUiStore((s) => s.patch)
  const ready = useMediaStore((s) => !!project && s.registeredKey === libraryKey(project))
  const [failed, setFailed] = useState<Record<string, true>>({})
  const els = useRef(new Map<string, MediaEl>())

  const fps = project?.settings.fps ?? 30
  const aspect = project ? project.settings.width / project.settings.height : 16 / 9
  const { ref, box } = useFit(aspect)
  const end = project ? timelineEnd(project) : 0
  const hasProxy = !!project?.media.some((a) => a.proxy)
  const layers = useMemo(() => (project && ready ? computeLayers(project, playhead) : []), [project, ready, playhead])

  // Keep every media element in step with the playhead.
  useEffect(() => {
    for (const L of layers) {
      const el = els.current.get(L.clip.id)
      if (!el || L.kind === 'image') continue
      el.muted = muted || L.muted
      el.volume = Math.min(1, Math.max(0, effectiveGain(L.clip, L.track, playhead)))
      const expected = sourceSeconds(L.clip, Math.max(playhead, L.clip.startFrame), fps)
      if (!L.active) {
        // Upcoming clip: park it on its first frame so it starts instantly.
        if (!el.paused) el.pause()
        if (Math.abs(el.currentTime - expected) > 0.05) el.currentTime = expected
      } else if (playing) {
        if (el.paused) {
          el.currentTime = expected
          void el.play().catch(() => undefined)
        } else if (Math.abs(el.currentTime - expected) > 0.3) {
          el.currentTime = expected // drifted or the user seeked
        }
      } else {
        if (!el.paused) el.pause()
        const target = expected + 0.5 / fps // aim at the middle of the frame
        if (Math.abs(el.currentTime - target) > 0.5 / fps) el.currentTime = target
      }
    }
  }, [layers, playhead, playing, muted, fps])

  // Pause everything when playback stops or the project closes.
  useEffect(() => {
    if (playing) return
    els.current.forEach((el) => !el.paused && el.pause())
  }, [playing])

  const setRef = (id: string) => (el: MediaEl | null) => {
    if (el) els.current.set(id, el)
    else els.current.delete(id)
  }
  const fail = (id: string) => setFailed((f) => (f[id] ? f : { ...f, [id]: true }))
  const problems = layers.filter((l) => l.active && failed[l.clip.id])
  const scale = project && box.h > 0 ? box.h / project.settings.height : 0
  // One subtitle at most per visible subtitle track, drawn with that track's style.
  const shownCues = project
    ? project.tracks.filter((t) => t.kind === 'subtitle' && t.visible).flatMap((t) => {
        const cue = project.subtitles.find((c) => c.trackId === t.id && c.startFrame <= playhead && playhead < c.startFrame + c.durationFrames)
        return cue && cue.text.trim() ? [{ track: t, cue }] : []
      })
    : []

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-ink-900" aria-label="Preview">
      <div ref={ref} className="flex min-h-0 flex-1 items-center justify-center">
        <div className="relative overflow-hidden rounded-sm border border-ink-600 bg-black" style={{ width: box.w, height: box.h }}>
          {layers.map((L) => {
            const src = previewUrl(L.asset, useProxies)
            const shown = L.active && L.visible
            const key = `${L.clip.id}|${src}`
            if (L.kind === 'audio') {
              return <audio key={key} ref={setRef(L.clip.id)} src={src} preload="auto" onError={() => fail(L.clip.id)} />
            }
            if (L.kind === 'image') {
              return (
                <img key={key} src={src} alt="" draggable={false} onError={() => fail(L.clip.id)}
                  className="absolute inset-0 h-full w-full object-contain" style={{ zIndex: L.z, visibility: shown ? 'visible' : 'hidden', ...layerLook(L.clip, playhead) }} />
              )
            }
            return (
              <video key={key} ref={setRef(L.clip.id)} src={src} preload="auto" playsInline onError={() => fail(L.clip.id)}
                className="absolute inset-0 h-full w-full object-contain" style={{ zIndex: L.z, visibility: shown ? 'visible' : 'hidden', ...layerLook(L.clip, playhead) }} />
            )
          })}
          {shownCues.map(({ track, cue }) => {
            const style = subtitleStyleOf(track)
            return (
              <div key={cue.id} style={{ ...subtitleBlockCss(style, scale), zIndex: 1000 }}>
                <span style={subtitleBoxCss(style, scale)}>{cue.text}</span>
              </div>
            )
          })}
          {(!project || end === 0) && (
            <div className="absolute inset-0 flex items-center justify-center text-ink-300">
              {project ? 'Add clips to the timeline to preview them' : 'No project open'}
            </div>
          )}
          {problems.length > 0 && (
            <div role="alert" className="absolute inset-x-2 bottom-2 z-50 rounded bg-black/80 p-2 text-center text-xs text-amber-200">
              Can't preview {problems.map((l) => l.asset.name).join(', ')}. The file may be missing or use a format this player can't decode. Making a proxy (lightning icon in the library) usually fixes it.
            </div>
          )}
        </div>
      </div>

      <div className="grid h-11 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-t border-ink-950 bg-ink-800 px-3">
        <div className="font-mono text-sm tabular-nums" aria-label="Timecode">
          {framesToTimecode(playhead, fps)}
          <span className="text-ink-300"> / {framesToTimecode(end, fps)}</span>
        </div>
        <div className="flex items-center gap-1">
          <button className="icon-btn" title="Go to start (Home)" disabled={!project} onClick={() => patch({ playhead: 0 })}><SkipBack size={16} /></button>
          <button className="icon-btn" title="Previous frame (←)" disabled={!project || playing} onClick={() => patch({ playhead: Math.max(0, playhead - 1) })}><StepBack size={16} /></button>
          <button className="icon-btn bg-accent text-white hover:!bg-accent-hover" title={playing ? 'Pause (Space)' : 'Play (Space)'} disabled={!project || end === 0} onClick={togglePlayback}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button className="icon-btn" title="Next frame (→)" disabled={!project || playing} onClick={() => patch({ playhead: playhead + 1 })}><StepForward size={16} /></button>
        </div>
        <div className="flex items-center justify-end gap-2 text-ink-300">
          {hasProxy && (
            <button className={`icon-btn icon-btn-sm ${useProxies ? 'bg-accent-soft !text-accent' : ''}`} aria-pressed={useProxies} title={useProxies ? 'Previewing proxies (faster). Click to use originals' : 'Previewing originals. Click to use proxies'} onClick={() => patch({ useProxies: !useProxies })}><Zap size={14} /></button>
          )}
          <button className="icon-btn icon-btn-sm" aria-pressed={muted} title={muted ? 'Unmute preview' : 'Mute preview'} onClick={() => patch({ previewMuted: !muted })}>
            {muted ? <VolumeX size={15} className="text-accent" /> : <Volume2 size={15} />}
          </button>
          <span>{project ? `${project.settings.width} × ${project.settings.height} · ${fps} fps` : '—'}</span>
        </div>
      </div>
    </section>
  )
}
