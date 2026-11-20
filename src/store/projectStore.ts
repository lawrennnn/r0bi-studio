import { create } from 'zustand'
import { makeTrack, type Project, type ProjectSettings, type Track, type TrackKind } from '@shared/project'

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error'
const HISTORY_LIMIT = 100

interface ProjectState {
  project: Project | null
  dir: string | null
  status: SaveStatus
  revision: number
  autosavedAt: number | null
  error: string | null
  past: Project[]
  future: Project[]
  /** For merging rapid edits (slider drags, typing) into one undo step. */
  lastKey: string | null
  lastAt: number

  load(project: Project, dir: string, opts?: { dirty?: boolean }): void
  close(): void
  /** Edits with the same coalesceKey made within a second of each other become one undo step. */
  commit(mutate: (draft: Project) => void, coalesceKey?: string): void
  undo(): void
  redo(): void
  markSaved(saved: Project, atRevision: number): void
  setStatus(status: SaveStatus): void
  setAutosaved(at: number): void
  setError(error: string | null): void
  setDir(dir: string): void
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: null,
  dir: null,
  status: 'saved',
  revision: 0,
  autosavedAt: null,
  error: null,
  past: [],
  future: [],
  lastKey: null,
  lastAt: 0,

  load: (project, dir, opts) =>
    set({
      project,
      dir,
      status: opts?.dirty ? 'dirty' : 'saved',
      revision: 0,
      autosavedAt: null,
      error: null,
      past: [],
      future: [],
      lastKey: null
    }),

  close: () => set({ project: null, dir: null, status: 'saved', past: [], future: [], error: null, lastKey: null }),

  commit: (mutate, coalesceKey) => {
    const { project, past, revision, lastKey, lastAt } = get()
    if (!project) return
    const next = structuredClone(project)
    mutate(next)
    const now = Date.now()
    const merge = coalesceKey !== undefined && coalesceKey === lastKey && now - lastAt < 1000 && past.length > 0
    set({
      project: next,
      past: merge ? past : [...past, project].slice(-HISTORY_LIMIT),
      future: [],
      status: 'dirty',
      revision: revision + 1,
      lastKey: coalesceKey ?? null,
      lastAt: now
    })
  },

  undo: () => {
    const { project, past, future, revision } = get()
    if (!project || past.length === 0) return
    set({
      project: past[past.length - 1],
      past: past.slice(0, -1),
      future: [project, ...future],
      status: 'dirty',
      revision: revision + 1,
      lastKey: null
    })
  },

  redo: () => {
    const { project, past, future, revision } = get()
    if (!project || future.length === 0) return
    set({
      project: future[0],
      past: [...past, project],
      future: future.slice(1),
      status: 'dirty',
      revision: revision + 1,
      lastKey: null
    })
  },

  // Keep history intact; only adopt the server-stamped updatedAt. If the user edited while
  // the save was in flight, the project stays dirty.
  markSaved: (saved, atRevision) => {
    const { project, revision } = get()
    if (!project) return
    if (revision === atRevision) set({ project: { ...project, updatedAt: saved.updatedAt }, status: 'saved' })
    else set({ status: 'dirty' })
  },

  setStatus: (status) => set({ status }),
  setAutosaved: (at) => set({ autosavedAt: at }),
  setError: (error) => set({ error }),
  setDir: (dir) => set({ dir })
}))

// Project edits. Every one goes through commit() so it lands in the undo history.
export const editProject = {
  rename: (name: string) => useProjectStore.getState().commit((d) => void (d.name = name.trim().slice(0, 80))),
  setSettings: (patch: Partial<ProjectSettings>) =>
    useProjectStore.getState().commit((d) => void (d.settings = { ...d.settings, ...patch })),
  addTrack: (kind: TrackKind) =>
    useProjectStore.getState().commit((d) => {
      const track = makeTrack(kind, d.tracks)
      let at = d.tracks.length
      for (let i = d.tracks.length - 1; i >= 0; i--) {
        if (d.tracks[i].kind === kind) {
          at = i + 1
          break
        }
      }
      d.tracks.splice(at, 0, track)
    }),
  toggleTrack: (id: string, prop: 'muted' | 'locked' | 'visible') =>
    useProjectStore.getState().commit((d) => {
      const t: Track | undefined = d.tracks.find((x) => x.id === id)
      if (t) t[prop] = !t[prop]
    })
}
