import type { Clip, Track } from './project'

/** Waveform resolution: one loudness peak per 20 ms of audio. */
export const PEAKS_PER_SECOND = 50

/** Linear fade envelope, 0 to 1, for a frame inside a clip. Fades are measured from the clip edges. */
export function envelope(startFrame: number, durationFrames: number, fadeIn: number, fadeOut: number, frame: number): number {
  const rel = frame - startFrame
  if (rel < 0 || rel >= durationFrames) return 0
  let g = 1
  if (fadeIn > 0 && rel < fadeIn) g = Math.min(g, (rel + 0.5) / fadeIn)
  const fromEnd = durationFrames - rel
  if (fadeOut > 0 && fromEnd <= fadeOut) g = Math.min(g, (fromEnd - 0.5) / fadeOut)
  return Math.min(1, Math.max(0, g))
}

/** Sound fade envelope at a timeline frame. */
export function fadeGain(clip: Pick<Clip, 'startFrame' | 'durationFrames' | 'fadeInFrames' | 'fadeOutFrames'>, frame: number): number {
  return envelope(clip.startFrame, clip.durationFrames, clip.fadeInFrames, clip.fadeOutFrames, frame)
}

/** Picture opacity at a timeline frame (1 = fully visible). */
export function clipOpacity(clip: Pick<Clip, 'startFrame' | 'durationFrames' | 'videoFadeInFrames' | 'videoFadeOutFrames'>, frame: number): number {
  return envelope(clip.startFrame, clip.durationFrames, clip.videoFadeInFrames, clip.videoFadeOutFrames, frame)
}

/** The level the preview (and later the export) uses: clip level x track level x fades, 0 to 1. */
export function effectiveGain(clip: Clip, track: Pick<Track, 'volume' | 'muted'>, frame: number): number {
  if (track.muted) return 0
  return (clip.volume / 100) * (track.volume / 100) * fadeGain(clip, frame)
}
