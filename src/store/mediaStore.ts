import { create } from 'zustand'
import type { ToolStatus } from '@shared/api'

export type Busy = 'proxy' | 'relink'

interface MediaState {
  thumbs: Record<string, string>
  /** Loudness peaks (one byte per 20 ms) for audio assets, used to draw waveforms. */
  waveforms: Record<string, Uint8Array>
  missing: Record<string, true>
  busy: Record<string, Busy>
  selected: string | null
  tools: ToolStatus | null
  importing: boolean
  dragging: boolean
  notice: string | null
  /** Library state the main process last registered for preview loading (see libraryKey). */
  registeredKey: string
  patch(p: Partial<Omit<MediaState, 'patch' | 'reset' | 'setBusy'>>): void
  setBusy(id: string, busy: Busy | null): void
  reset(): void
}

const initial = { thumbs: {}, waveforms: {}, missing: {}, busy: {}, selected: null, importing: false, dragging: false, notice: null, registeredKey: '' }

export const useMediaStore = create<MediaState>((set) => ({
  ...initial,
  tools: null,
  patch: (p) => set(p),
  setBusy: (id, busy) =>
    set((s) => {
      const next = { ...s.busy }
      if (busy) next[id] = busy
      else delete next[id]
      return { busy: next }
    }),
  reset: () => set({ ...initial })
}))
