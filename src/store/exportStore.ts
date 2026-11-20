import { create } from 'zustand'
import type { ExportInfo, ExportJobInfo } from '@shared/api'
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings } from '@shared/render'

interface ExportState {
  open: boolean
  jobs: ExportJobInfo[]
  info: ExportInfo | null
  settings: ExportSettings
  /** The user typed a file name, so stop following the project name. */
  nameTouched: boolean
  /** Text while subtitle images are being prepared, e.g. "Preparing subtitles 3/20". */
  preparing: string | null
  error: string | null
  patch(p: Partial<Omit<ExportState, 'patch' | 'set'>>): void
  set(p: Partial<ExportSettings>): void
}

export const useExportStore = create<ExportState>((set) => ({
  open: false,
  jobs: [],
  info: null,
  settings: DEFAULT_EXPORT_SETTINGS,
  nameTouched: false,
  preparing: null,
  error: null,
  patch: (p) => set(p),
  set: (p) => set((s) => ({ settings: { ...s.settings, ...p } }))
}))

export const isActive = (j: ExportJobInfo) => j.status === 'queued' || j.status === 'preparing' || j.status === 'rendering' || j.status === 'verifying'
