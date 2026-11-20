import { create } from 'zustand'
import type { AutomationData, BatchProject } from '@shared/api'
import { DEFAULT_RECIPE, type Recipe } from '@shared/automation'

export type AutomationTab = 'assemble' | 'templates' | 'scenes'

interface AutomationState {
  data: AutomationData | null
  tab: AutomationTab
  recipe: Recipe
  /** Scene items chosen for assembly, in play order (library asset ids). */
  sceneIds: string[]
  narrationId: string | null
  musicId: string | null
  mode: 'replace' | 'append'
  notice: string | null
  busy: boolean
  batchOpen: boolean
  batchProjects: BatchProject[]
  patch(p: Partial<Omit<AutomationState, 'patch' | 'setRecipe'>>): void
  setRecipe(p: Partial<Recipe>): void
}

export const useAutomationStore = create<AutomationState>((set) => ({
  data: null,
  tab: 'assemble',
  recipe: DEFAULT_RECIPE,
  sceneIds: [],
  narrationId: null,
  musicId: null,
  mode: 'replace',
  notice: null,
  busy: false,
  batchOpen: false,
  batchProjects: [],
  patch: (p) => set(p),
  setRecipe: (p) => set((s) => ({ recipe: { ...s.recipe, ...p } }))
}))
