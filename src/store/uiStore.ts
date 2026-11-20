import { create } from 'zustand'
import type { MediaKind } from '@shared/project'

export type LeftTab = 'media' | 'scenes' | 'audio' | 'images' | 'subtitles' | 'effects' | 'templates'
export type RightTab = 'project' | 'clip' | 'audio' | 'subtitle' | 'transition' | 'ai'

export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

interface UiState {
  leftWidth: number
  rightWidth: number
  timelineHeight: number
  leftCollapsed: boolean
  rightCollapsed: boolean
  leftTab: LeftTab
  rightTab: RightTab
  /** Timeline zoom in pixels per second. */
  zoom: number
  /** Playhead position in integer frames. */
  playhead: number
  selectedClipId: string | null
  selectedCueId: string | null
  /** Subtitle track the Subtitles panel is working on. */
  subtitleTrackId: string | null
  playing: boolean
  previewMuted: boolean
  /** Use 540p proxies in the preview when they exist. */
  useProxies: boolean
  /** Magnet: snap clip edges to other clips, the playhead and zero. */
  snapping: boolean
  /** Library item currently being dragged toward the timeline. */
  dragAsset: { id: string; kind: MediaKind } | null
  patch(p: Partial<Omit<UiState, 'patch'>>): void
}

export const useUiStore = create<UiState>((set) => ({
  leftWidth: 280,
  rightWidth: 300,
  timelineHeight: 280,
  leftCollapsed: false,
  rightCollapsed: false,
  leftTab: 'media',
  rightTab: 'project',
  zoom: 40,
  playhead: 0,
  selectedClipId: null,
  selectedCueId: null,
  subtitleTrackId: null,
  playing: false,
  previewMuted: false,
  useProxies: true,
  snapping: true,
  dragAsset: null,
  patch: (p) => set(p)
}))
