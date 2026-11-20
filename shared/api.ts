import type { MediaAsset, Project, ProjectHandle, Result } from './project'
import type { ChatTurn, ThumbnailInput } from './ai'
import type { Preset, Scene, Template } from './automation'
import type { ExportSettings } from './render'

export interface ToolInfo {
  found: boolean
  version: string | null
  source: 'env' | 'path' | 'bundled' | null
}
export interface ToolStatus {
  ffmpeg: ToolInfo
  ffprobe: ToolInfo
}

export interface ImportFailure {
  name: string
  error: string
}
/** Thumbnails are returned as small data: URLs so the renderer needs no file access. */
export interface ImportResult {
  assets: MediaAsset[]
  thumbs: Record<string, string>
  failures: ImportFailure[]
}
export interface RefreshResult {
  missing: string[]
  thumbs: Record<string, string>
}
export interface RelinkResult {
  asset: MediaAsset
  thumb: string | null
  durationDiffers: boolean
}
/** Minimal info the main process needs to skip files that are already in the project. */
export interface ExistingRef {
  path: string
  pathKind: 'relative' | 'absolute'
}

export type ExportJobStatus = 'queued' | 'preparing' | 'rendering' | 'verifying' | 'done' | 'failed' | 'cancelled'
export interface ExportVerification {
  ok: boolean
  width: number
  height: number
  fps: number
  durationSec: number
  videoCodec: string | null
  audioCodec: string | null
  problems: string[]
}
export interface ExportJobInfo {
  id: string
  name: string
  status: ExportJobStatus
  /** 0 to 1 */
  progress: number
  outputPath: string | null
  error: string | null
  /** Plain-language extra info, such as "GPU encoding failed, finished on CPU". */
  note: string | null
  encoder: 'cpu' | 'nvenc' | null
  seconds: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  verification: ExportVerification | null
}
export interface ExportInfo {
  /** A working NVIDIA hardware encoder was found. */
  nvenc: boolean
  /** The open project's default export folder. */
  projectFolder: string | null
  /** The folder chosen with "Choose folder", if any. */
  customFolder: string | null
}

export interface AiStatus {
  hasKey: boolean
  /** Enough of the key to recognise it, never all of it. */
  keyHint: string | null
  model: string
  /** False when this computer cannot encrypt secrets, so a key cannot be saved. */
  encryptionAvailable: boolean
}
export interface AiPlanRequest {
  request: string
  history: ChatTurn[]
  /** Project metadata with short ids (see shared/ai.ts buildContext). No files or paths. */
  context: unknown
  thumbnails: ThumbnailInput[]
}
export interface AiPlanResponse {
  /** The model's tool input. The page validates it against the command schema before using it. */
  plan: unknown
  usage: { inputTokens: number; outputTokens: number }
  model: string
}

export type AutomationKind = 'templates' | 'scenes' | 'presets'
export interface AutomationData {
  templates: Template[]
  scenes: Scene[]
  presets: Preset[]
}
/** A project chosen for batch export. The folder is only for display; the main process keeps the real one. */
export interface BatchProject {
  token: string
  name: string
  folder: string
  project: Project
}

export interface SubtitleFile {
  name: string
  text: string
}

/** The only surface the renderer can use to reach the main process. */
export interface R0biApi {
  project: {
    create(name: string): Promise<Result<ProjectHandle>>
    open(): Promise<Result<ProjectHandle>>
    save(project: Project): Promise<Result<Project>>
    saveAs(project: Project): Promise<Result<ProjectHandle>>
    autosave(project: Project): Promise<Result<null>>
  }
  media: {
    toolStatus(): Promise<Result<ToolStatus>>
    /** Opens the native file picker. */
    importDialog(existing: ExistingRef[]): Promise<Result<ImportResult>>
    /** For drag-and-drop; the main process validates every path. */
    importPaths(paths: string[], existing: ExistingRef[]): Promise<Result<ImportResult>>
    refresh(assets: MediaAsset[], haveThumbs: string[]): Promise<Result<RefreshResult>>
    relink(asset: MediaAsset): Promise<Result<RelinkResult>>
    makeProxy(asset: MediaAsset): Promise<Result<{ proxy: string }>>
    cancelProxy(id: string): Promise<Result<null>>
    /** Loudness peaks (one byte per 20 ms, base64) for audio assets, keyed by asset id. */
    waveforms(assets: MediaAsset[]): Promise<Result<Record<string, string>>>
    /** Resolve a dropped File to its filesystem path. */
    getPathForFile(file: File): string
  }
  export: {
    info(): Promise<Result<ExportInfo>>
    chooseFolder(): Promise<Result<string>>
    /** Start a batch of subtitle images for one export. */
    prepare(): Promise<Result<{ prepId: string }>>
    /** Upload subtitle images (PNG, base64) drawn by the app, so exported text matches the preview. */
    subtitleImages(prepId: string, items: { key: string; data: string }[]): Promise<Result<null>>
    /** cueImages maps each subtitle cue id to an image key; the key "blank" must be a transparent frame. */
    enqueue(prepId: string, project: Project, settings: ExportSettings, cueImages: Record<string, string>, projectToken?: string): Promise<Result<ExportJobInfo>>
    list(): Promise<Result<ExportJobInfo[]>>
    cancel(id: string): Promise<Result<null>>
    clearFinished(): Promise<Result<null>>
    reveal(id: string): Promise<Result<null>>
    onUpdate(cb: (jobs: ExportJobInfo[]) => void): () => void
  }
  automation: {
    load(): Promise<Result<AutomationData>>
    save(kind: AutomationKind, item: unknown): Promise<Result<AutomationData>>
    remove(kind: AutomationKind, id: string): Promise<Result<AutomationData>>
    /** Pick other project files for a batch export. */
    pickProjects(): Promise<Result<BatchProject[]>>
  }
  ai: {
    getSettings(): Promise<Result<AiStatus>>
    /** key: a string saves it (encrypted), null removes it, undefined leaves it. The key never comes back to the page. */
    saveSettings(change: { model?: string; key?: string | null }): Promise<Result<AiStatus>>
    test(): Promise<Result<{ model: string }>>
    plan(req: AiPlanRequest): Promise<Result<AiPlanResponse>>
    cancel(): Promise<Result<null>>
  }
  subtitles: {
    /** Opens the file picker and returns the chosen .srt file's decoded text. */
    importDialog(): Promise<Result<SubtitleFile>>
  }
  app: {
    setDirty(dirty: boolean): void
  }
}
