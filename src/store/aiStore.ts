import { create } from 'zustand'
import type { AiStatus } from '@shared/api'
import type { Aliases, AiPlan, ExecResult } from '@shared/ai'

export interface PlanState {
  plan: AiPlan
  /** Dry run against the project when the plan arrived (and again when applied). */
  exec: ExecResult
  aliases: Aliases
  status: 'pending' | 'applied' | 'discarded'
  usage: { inputTokens: number; outputTokens: number } | null
  model: string | null
}

export interface AiMessage {
  id: string
  role: 'user' | 'assistant' | 'error'
  text: string
  plan?: PlanState
}

interface AiState {
  messages: AiMessage[]
  busy: boolean
  status: AiStatus | null
  settingsOpen: boolean
  /** Send small thumbnails of the clips' media with each request. Off by default. */
  includeThumbnails: boolean
  patch(p: Partial<Omit<AiState, 'patch' | 'push' | 'update' | 'reset'>>): void
  push(m: Omit<AiMessage, 'id'>): string
  update(id: string, fn: (m: AiMessage) => AiMessage): void
  reset(): void
}

let nextId = 1

export const useAiStore = create<AiState>((set) => ({
  messages: [],
  busy: false,
  status: null,
  settingsOpen: false,
  includeThumbnails: false,
  patch: (p) => set(p),
  push: (m) => {
    const id = `m${nextId++}`
    set((s) => ({ messages: [...s.messages, { ...m, id }] }))
    return id
  },
  update: (id, fn) => set((s) => ({ messages: s.messages.map((m) => (m.id === id ? fn(m) : m)) })),
  reset: () => set({ messages: [], busy: false })
}))
