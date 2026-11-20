import type { Clip, MediaAsset, Project, Track } from './project'
import { clipEnd } from './timeline'

/** Pure preview composition: which media should exist in the preview for a given frame. */

export const LOOKAHEAD_SECONDS = 2

export interface PreviewLayer {
  clip: Clip
  asset: MediaAsset
  track: Track
  kind: 'video' | 'image' | 'audio'
  /** The playhead is inside this clip. Inactive layers are upcoming clips being preloaded. */
  active: boolean
  /** Stacking order; higher is drawn on top. Tracks listed first in the timeline are on top. */
  z: number
  /** Should the picture be shown (video/image on a visible video or overlay track). */
  visible: boolean
  muted: boolean
}

export function computeLayers(p: Pick<Project, 'clips' | 'tracks' | 'media' | 'settings'>, frame: number): PreviewLayer[] {
  const lookahead = Math.round(LOOKAHEAD_SECONDS * p.settings.fps)
  const tracks = new Map(p.tracks.map((t, i) => [t.id, { t, i }]))
  const assets = new Map(p.media.map((a) => [a.id, a]))
  const layers: PreviewLayer[] = []
  for (const clip of p.clips) {
    const entry = tracks.get(clip.trackId)
    const asset = assets.get(clip.assetId)
    if (!entry || !asset || entry.t.kind === 'subtitle') continue
    const active = clip.startFrame <= frame && frame < clipEnd(clip)
    const upcoming = !active && clip.startFrame > frame && clip.startFrame <= frame + lookahead
    if (!active && !upcoming) continue
    const visual = (entry.t.kind === 'video' || entry.t.kind === 'overlay') && asset.kind !== 'audio'
    layers.push({
      clip,
      asset,
      track: entry.t,
      kind: asset.kind,
      active,
      z: p.tracks.length - entry.i,
      visible: visual && entry.t.visible,
      // Overlay tracks have no mute control, so their sound is left out of the preview mix.
      muted: entry.t.muted || entry.t.kind === 'overlay' || asset.kind === 'image'
    })
  }
  return layers.sort((a, b) => a.z - b.z || a.clip.startFrame - b.clip.startFrame)
}

/** Seconds into the source file for a given timeline frame (clamped to the clip). */
export function sourceSeconds(clip: Clip, frame: number, fps: number): number {
  const offset = Math.min(Math.max(0, frame - clip.startFrame), clip.durationFrames - 1)
  return (clip.sourceInFrame + offset) / fps
}

export function previewUrl(asset: Pick<MediaAsset, 'id' | 'proxy' | 'kind'>, useProxy: boolean): string {
  const kind = useProxy && asset.kind === 'video' && asset.proxy ? 'proxy' : 'asset'
  return `r0bi-media://${kind}/${encodeURIComponent(asset.id)}`
}
