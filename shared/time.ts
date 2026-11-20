/** All timeline math uses integer frames to avoid floating-point drift. */
export function framesToTimecode(frames: number, fps: number): string {
  const f = Math.max(0, Math.floor(frames))
  const totalSeconds = Math.floor(f / fps)
  const ff = f % fps
  const ss = totalSeconds % 60
  const mm = Math.floor(totalSeconds / 60) % 60
  const hh = Math.floor(totalSeconds / 3600)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`
}

export function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps)
}
