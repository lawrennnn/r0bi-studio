import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProject, type MediaAsset } from '../shared/project'
import { useProjectStore } from '../src/store/projectStore'
import { useUiStore } from '../src/store/uiStore'
import { timeline } from '../src/store/timelineActions'
import { pause, play, togglePlayback } from '../src/lib/playback'

let now = 0
let queue: ((t: number) => void)[] = []
/** Advance fake time by `ms`, running animation frames every 16 ms. */
const advance = (ms: number) => {
  const stop = now + ms
  while (now < stop) {
    now = Math.min(stop, now + 16)
    const run = queue
    queue = []
    run.forEach((cb) => cb(now))
  }
}

const video: MediaAsset = {
  id: 'v', kind: 'video', name: 'v.mp4', path: '/v.mp4', pathKind: 'absolute', sizeBytes: 1, durationMs: 10_000,
  width: 1920, height: 1080, fpsNum: 30, fpsDen: 1, videoCodec: 'h264', audioCodec: 'aac', sampleRate: 48000, channels: 2,
  thumbnail: null, proxy: null, importedAt: ''
}
const ui = () => useUiStore.getState()

beforeEach(() => {
  now = 1000
  queue = []
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => (queue.push(cb), queue.length))
  vi.stubGlobal('cancelAnimationFrame', () => { queue = [] })
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const p = createEmptyProject('P')
  p.media = [video]
  useProjectStore.getState().load(p, '/tmp/p')
  useUiStore.getState().patch({ playhead: 0, playing: false, selectedClipId: null })
  timeline.addAsset('v', p.tracks.find((t) => t.name === 'Video 1')!.id, 0) // 300 frames = 10 s
})
afterEach(() => {
  pause()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('playback clock', () => {
  it('advances the playhead in real time at the project frame rate', () => {
    play()
    expect(ui().playing).toBe(true)
    advance(1000)
    expect(ui().playhead).toBeGreaterThanOrEqual(28)
    expect(ui().playhead).toBeLessThanOrEqual(31)
    advance(1000)
    expect(ui().playhead).toBeGreaterThanOrEqual(58)
    expect(ui().playhead).toBeLessThanOrEqual(61)
  })

  it('stops on the last frame at the end of the timeline', () => {
    ui().patch({ playhead: 280 })
    play()
    advance(2000)
    expect(ui().playing).toBe(false)
    expect(ui().playhead).toBe(299)
  })

  it('restarts from the beginning when played from the end', () => {
    ui().patch({ playhead: 299 })
    play()
    expect(ui().playhead).toBe(0)
    expect(ui().playing).toBe(true)
  })

  it('pauses where it is and toggles', () => {
    togglePlayback()
    advance(500)
    togglePlayback()
    const at = ui().playhead
    expect(ui().playing).toBe(false)
    advance(1000)
    expect(ui().playhead).toBe(at)
  })

  it('continues from the new position when the user seeks during playback', () => {
    play()
    advance(300)
    ui().patch({ playhead: 200 })
    advance(500)
    expect(ui().playhead).toBeGreaterThanOrEqual(212)
    expect(ui().playhead).toBeLessThanOrEqual(216)
  })

  it('does nothing on an empty timeline and stops if the frame rate changes', () => {
    useProjectStore.getState().load(createEmptyProject('Empty'), '/tmp/e')
    play()
    expect(ui().playing).toBe(false)

    const p = createEmptyProject('P2')
    p.media = [video]
    useProjectStore.getState().load(p, '/tmp/p2')
    timeline.addAsset('v', p.tracks.find((t) => t.name === 'Video 1')!.id, 0)
    play()
    advance(200)
    timeline.setFps(60)
    advance(100)
    expect(ui().playing).toBe(false)
  })
})
