import { DEFAULT_EFFECTS, type Clip, type ClipEffects } from './project'

/** Picture effects: opacity, zoom and position animation. Pure helpers used by the preview, the editor and the export. */

export const effectsOf = (c: Pick<Clip, 'effects'>): ClipEffects => ({ ...DEFAULT_EFFECTS, ...c.effects })

const keys = Object.keys(DEFAULT_EFFECTS) as (keyof ClipEffects)[]

/** Undefined when every value is the default, so clips without effects stay clean in the project file. */
export function compactEffects(e: ClipEffects): ClipEffects | undefined {
  return keys.every((k) => e[k] === DEFAULT_EFFECTS[k]) ? undefined : { ...e }
}

export const hasEffects = (c: Pick<Clip, 'effects'>): boolean => compactEffects(effectsOf(c)) !== undefined
export const isZoomed = (e: ClipEffects): boolean => e.scaleStart !== 100 || e.scaleEnd !== 100
export const isMoved = (e: ClipEffects): boolean => e.posStartX !== 0 || e.posStartY !== 0 || e.posEndX !== 0 || e.posEndY !== 0

/** How far through the clip a frame is, 0 on the first frame and 1 on the last. */
export function progressAt(clip: Pick<Clip, 'startFrame' | 'durationFrames'>, frame: number): number {
  const span = Math.max(1, clip.durationFrames - 1)
  return Math.min(1, Math.max(0, (frame - clip.startFrame) / span))
}

const lerp = (a: number, b: number, p: number) => a + (b - a) * p

/** What to draw at a timeline frame: opacity 0-1, zoom factor (1 = normal) and offset in percent of the frame. */
export function effectsAt(clip: Pick<Clip, 'effects' | 'startFrame' | 'durationFrames'>, frame: number): { opacity: number; scale: number; x: number; y: number } {
  const e = effectsOf(clip)
  const p = progressAt(clip, frame)
  return { opacity: e.opacity / 100, scale: lerp(e.scaleStart, e.scaleEnd, p) / 100, x: lerp(e.posStartX, e.posEndX, p), y: lerp(e.posStartY, e.posEndY, p) }
}

/** Cut an animation in two so it carries on smoothly across a split. */
export function splitEffects(effects: ClipEffects, durationFrames: number, leftLen: number): [ClipEffects | undefined, ClipEffects | undefined] {
  const span = Math.max(1, durationFrames - 1)
  const at = (f: number) => Math.min(1, Math.max(0, f / span))
  const pl = at(leftLen - 1)
  const pr = at(leftLen)
  const r = (a: number, b: number, p: number) => Math.round(lerp(a, b, p))
  const left: ClipEffects = {
    ...effects,
    scaleEnd: r(effects.scaleStart, effects.scaleEnd, pl),
    posEndX: r(effects.posStartX, effects.posEndX, pl),
    posEndY: r(effects.posStartY, effects.posEndY, pl)
  }
  const right: ClipEffects = {
    ...effects,
    scaleStart: r(effects.scaleStart, effects.scaleEnd, pr),
    posStartX: r(effects.posStartX, effects.posEndX, pr),
    posStartY: r(effects.posStartY, effects.posEndY, pr)
  }
  return [compactEffects(left), compactEffects(right)]
}

export interface EffectPreset {
  id: string
  label: string
  effects: Partial<ClipEffects>
}

/** One-click Ken Burns style moves. Panning presets zoom in slightly so no edge is revealed. */
export const EFFECT_PRESETS: EffectPreset[] = [
  { id: 'zoom-in', label: 'Slow zoom in', effects: { scaleStart: 100, scaleEnd: 115 } },
  { id: 'zoom-out', label: 'Slow zoom out', effects: { scaleStart: 115, scaleEnd: 100 } },
  { id: 'zoom-in-strong', label: 'Strong zoom in', effects: { scaleStart: 100, scaleEnd: 140 } },
  { id: 'pan-left', label: 'Pan left', effects: { scaleStart: 112, scaleEnd: 112, posStartX: 5, posEndX: -5 } },
  { id: 'pan-right', label: 'Pan right', effects: { scaleStart: 112, scaleEnd: 112, posStartX: -5, posEndX: 5 } },
  { id: 'pan-up', label: 'Pan up', effects: { scaleStart: 112, scaleEnd: 112, posStartY: 5, posEndY: -5 } },
  { id: 'pan-down', label: 'Pan down', effects: { scaleStart: 112, scaleEnd: 112, posStartY: -5, posEndY: 5 } }
]
