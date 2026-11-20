import { timelineEnd } from '@shared/timeline'
import { useProjectStore } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'

/**
 * Playback clock. The playhead (integer frames) is the single source of truth; the preview
 * follows it. Time comes from performance.now(), so the playhead stays correct even when a
 * video element stalls. A seek from anywhere else (ruler click, arrow keys) re-anchors the clock.
 */
let raf = 0

export function pause(): void {
  cancelAnimationFrame(raf)
  if (useUiStore.getState().playing) useUiStore.getState().patch({ playing: false })
}

export function play(): void {
  const project = useProjectStore.getState().project
  const ui = useUiStore.getState()
  if (!project || ui.playing) return
  const end = timelineEnd(project)
  if (end <= 0) return
  const fps = project.settings.fps
  const startFrame = ui.playhead >= end - 1 ? 0 : ui.playhead

  ui.patch({ playing: true, playhead: startFrame })
  let anchorTime = performance.now()
  let anchorFrame = startFrame
  let last = startFrame

  const tick = (now: number) => {
    const state = useUiStore.getState()
    if (!state.playing) return
    const current = useProjectStore.getState().project
    if (!current || current.settings.fps !== fps) return pause()

    if (state.playhead !== last) {
      // Someone else moved the playhead: continue from there.
      anchorFrame = state.playhead
      anchorTime = now
      last = state.playhead
    }
    const frame = anchorFrame + Math.floor(((now - anchorTime) / 1000) * fps)
    const endNow = timelineEnd(current)
    if (frame >= endNow - 1) {
      // Stop on the last frame so it stays visible.
      state.patch({ playhead: Math.max(0, endNow - 1), playing: false })
      return
    }
    if (frame !== last) {
      last = frame
      state.patch({ playhead: frame })
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
}

export function togglePlayback(): void {
  if (useUiStore.getState().playing) pause()
  else play()
}
