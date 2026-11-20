import { useEffect, useRef } from 'react'
import type { Clip, MediaAsset, SubtitleCue, TrackKind } from '@shared/project'
import { PEAKS_PER_SECOND } from '@shared/audio'
import { framesToTimecode } from '@shared/time'
import { hasEffects } from '@shared/effects'

const COLORS: Record<TrackKind, string> = {
  video: 'border-[#3d6fd6] bg-[#23428a]',
  overlay: 'border-[#8a63d2] bg-[#47307a]',
  audio: 'border-[#2f9c8a] bg-[#1d5e55]',
  subtitle: 'border-[#c9922e] bg-[#6b4d14]'
}
const WAVE_H = 32

type Mode = 'move' | 'trimL' | 'trimR'

function Handles({ onPointerDown }: { onPointerDown(e: React.PointerEvent, mode: Mode): void }) {
  return (
    <>
      <div onPointerDown={(e) => onPointerDown(e, 'trimL')} className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/50" aria-hidden="true" />
      <div onPointerDown={(e) => onPointerDown(e, 'trimR')} className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/50" aria-hidden="true" />
    </>
  )
}

/** Draws the loudest peak per pixel column for the part of the file this clip plays. */
function Waveform({ peaks, startSec, durSec, width }: { peaks: Uint8Array; startSec: number; durSec: number; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const w = Math.max(1, Math.min(Math.round(width), 3000))
  useEffect(() => {
    const ctx = ref.current?.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, WAVE_H)
    ctx.fillStyle = 'rgba(190,255,240,0.8)'
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor((startSec + (x / w) * durSec) * PEAKS_PER_SECOND)
      const i1 = Math.max(i0 + 1, Math.ceil((startSec + ((x + 1) / w) * durSec) * PEAKS_PER_SECOND))
      let m = 0
      for (let i = i0; i < Math.min(i1, peaks.length); i++) if (peaks[i] > m) m = peaks[i]
      const h = Math.max(1, (m / 255) * WAVE_H)
      ctx.fillRect(x, (WAVE_H - h) / 2, 1, h)
    }
  }, [peaks, startSec, durSec, w])
  return <canvas ref={ref} width={w} height={WAVE_H} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />
}

interface Props {
  clip: Clip
  asset: MediaAsset
  trackKind: TrackKind
  zoom: number
  fps: number
  thumb?: string
  peaks?: Uint8Array
  selected: boolean
  missing: boolean
  locked: boolean
  dragging: boolean
  onPointerDown(e: React.PointerEvent, mode: Mode): void
}

export function ClipBlock({ clip, asset, trackKind, zoom, fps, thumb, peaks, selected, missing, locked, dragging, onPointerDown }: Props) {
  const left = (clip.startFrame / fps) * zoom
  const width = Math.max(2, (clip.durationFrames / fps) * zoom)
  const fadeInPx = (clip.fadeInFrames / fps) * zoom
  const fadeOutPx = (clip.fadeOutFrames / fps) * zoom
  const vFadeInPx = (clip.videoFadeInFrames / fps) * zoom
  const vFadeOutPx = (clip.videoFadeOutFrames / fps) * zoom
  const title = `${asset.name}\nStart ${framesToTimecode(clip.startFrame, fps)}  Length ${framesToTimecode(clip.durationFrames, fps)}${clip.volume < 100 ? `\nVolume ${clip.volume}%` : ''}`

  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label={asset.name}
      aria-pressed={selected}
      title={title}
      onPointerDown={(e) => onPointerDown(e, 'move')}
      className={`absolute bottom-1 top-1 select-none overflow-hidden rounded border text-[11px] ${COLORS[trackKind]} ${
        selected ? 'z-10 ring-2 ring-white' : ''
      } ${dragging ? 'opacity-80 shadow-lg' : ''} ${locked ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'} ${
        missing ? 'bg-[repeating-linear-gradient(135deg,#7f1d1d,#7f1d1d_6px,#5b1515_6px,#5b1515_12px)] border-red-500' : ''
      }`}
      style={{ left, width }}
    >
      {peaks && asset.kind === 'audio' && (
        <Waveform peaks={peaks} startSec={clip.sourceInFrame / fps} durSec={clip.durationFrames / fps} width={width} />
      )}
      {fadeInPx > 1 && <div className="pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-black/60 to-transparent" style={{ width: fadeInPx }} aria-hidden="true" />}
      {fadeOutPx > 1 && <div className="pointer-events-none absolute inset-y-0 right-0 bg-gradient-to-l from-black/60 to-transparent" style={{ width: fadeOutPx }} aria-hidden="true" />}
      {vFadeInPx > 1 && <div className="pointer-events-none absolute left-0 top-0 h-1/2 bg-white/35" style={{ width: vFadeInPx, clipPath: 'polygon(0 0, 100% 0, 0 100%)' }} aria-hidden="true" />}
      {vFadeOutPx > 1 && <div className="pointer-events-none absolute right-0 top-0 h-1/2 bg-white/35" style={{ width: vFadeOutPx, clipPath: 'polygon(100% 0, 0 0, 100% 100%)' }} aria-hidden="true" />}
      <div className="pointer-events-none relative flex h-full items-center gap-1 px-1">
        {thumb && width > 60 && asset.kind !== 'audio' && <img src={thumb} alt="" className="h-full w-8 shrink-0 rounded-sm object-cover" draggable={false} />}
        <span className="truncate drop-shadow">{asset.name}</span>
        {hasEffects(clip) && <span className="ml-auto shrink-0 rounded bg-black/50 px-1 text-[9px] font-semibold tracking-wide" title="Has picture effects">FX</span>}
      </div>
      {!locked && <Handles onPointerDown={onPointerDown} />}
    </div>
  )
}

interface CueProps {
  cue: SubtitleCue
  zoom: number
  fps: number
  selected: boolean
  locked: boolean
  dragging: boolean
  onPointerDown(e: React.PointerEvent, mode: Mode): void
}

export function CueBlock({ cue, zoom, fps, selected, locked, dragging, onPointerDown }: CueProps) {
  const left = (cue.startFrame / fps) * zoom
  const width = Math.max(2, (cue.durationFrames / fps) * zoom)
  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label={cue.text || 'Empty subtitle'}
      aria-pressed={selected}
      title={`${cue.text || '(empty)'}\nStart ${framesToTimecode(cue.startFrame, fps)}  Length ${framesToTimecode(cue.durationFrames, fps)}`}
      onPointerDown={(e) => onPointerDown(e, 'move')}
      className={`absolute bottom-1 top-1 select-none overflow-hidden rounded border text-[11px] ${COLORS.subtitle} ${selected ? 'z-10 ring-2 ring-white' : ''} ${
        dragging ? 'opacity-80 shadow-lg' : ''
      } ${locked ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'}`}
      style={{ left, width }}
    >
      <div className="pointer-events-none flex h-full items-center px-1">
        <span className="truncate">{cue.text.replace(/\n/g, ' ') || '(empty)'}</span>
      </div>
      {!locked && <Handles onPointerDown={onPointerDown} />}
    </div>
  )
}
