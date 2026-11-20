import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, protocol, safeStorage, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z, ZodError } from 'zod'
import { MEDIA_EXTENSIONS, MediaAssetSchema, migrateProject, ProjectSchema, type Project, type ProjectHandle, type Result } from '../shared/project'
import type { ImportResult, RefreshResult, RelinkResult, SubtitleFile, ToolStatus } from '../shared/api'
import { decodeSubtitleBytes } from '../shared/srt'
import { MediaService } from './media/mediaService'
import { handleMediaRequest, MEDIA_SCHEME, MediaRegistry } from './media/protocol'
import { ProjectManager, sanitizeFileName } from './projectManager'
import { ExportSettingsSchema, type ExportSettings } from '../shared/render'
import type { AiPlanResponse, AiStatus, AutomationData, BatchProject, ExportInfo, ExportJobInfo } from '../shared/api'
import { PresetSchema, SceneSchema, TemplateSchema } from '../shared/automation'
import { JsonLibrary } from './automation/library'
import { buildMessages } from '../shared/ai'
import { AiSettings } from './ai/settings'
import { AiCancelled, pingModel, requestPlan } from './ai/client'
import { ExportQueue } from './export/queue'
import { detectNvenc, RenderCancelled, resolveEncoder, runRender } from './export/renderer'
import { getTool } from './media/binaries'

const DEV_URL = process.env.VITE_DEV_SERVER_URL
const isDev = Boolean(DEV_URL)
const manager = new ProjectManager()
const media = new MediaService()
const registry = new MediaRegistry()

// Must run before the app is ready: lets <video>/<img> load project media through r0bi-media://
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
])
// ---- AI assistant (optional) ---------------------------------------------------------------------
// The API key is encrypted with Windows (safeStorage) and lives only in the app's private data
// folder. The page can save or remove it, but it is never sent back to the page or to project files.
const aiSettings = new AiSettings(path.join(app.getPath('userData'), 'ai-settings.json'), {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => safeStorage.encryptString(s),
  decrypt: (b) => safeStorage.decryptString(b)
})
let aiAbort: AbortController | null = null

// ---- Automation library (templates, scenes, presets) -------------------------------------------------
const libraries = {
  templates: new JsonLibrary(path.join(app.getPath('userData'), 'library', 'templates.json'), TemplateSchema),
  scenes: new JsonLibrary(path.join(app.getPath('userData'), 'library', 'scenes.json'), SceneSchema),
  presets: new JsonLibrary(path.join(app.getPath('userData'), 'library', 'presets.json'), PresetSchema)
}
const allLibraries = (): AutomationData => ({ templates: libraries.templates.list(), scenes: libraries.scenes.list(), presets: libraries.presets.list() })
/** Projects picked for batch export: the page gets a token, the real folder stays here. */
const batchProjects = new Map<string, string>()

// ---- Export ----------------------------------------------------------------------------------
interface ExportPayload {
  project: Project
  projectDir: string
  settings: ExportSettings
  prepDir: string
  subtitleImages: Record<string, string>
  blankImage: string | null
  outputDir: string
}
const EXPORT_TMP = path.join(os.tmpdir(), 'r0bi-export')
const preps = new Map<string, string>()
let customOutputDir: string | null = null

async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`)
    try {
      await fs.access(candidate)
    } catch {
      return candidate
    }
  }
}

const exportQueue = new ExportQueue<ExportPayload>(
  async (p, hooks) => {
    hooks.status('preparing')
    const [ffmpeg, ffprobe] = await Promise.all([getTool('ffmpeg'), getTool('ffprobe')])
    if (!ffmpeg.path || !ffprobe.path) throw new Error('FFmpeg was not found. Run "npm install" again, or install FFmpeg and restart the app')
    const nvencOk = p.settings.encoder === 'cpu' ? false : await detectNvenc(ffmpeg.path)
    let encoder = resolveEncoder(p.settings.encoder, nvencOk)
    if (p.settings.encoder === 'nvenc' && !nvencOk) hooks.note('No usable NVIDIA encoder was found, so the CPU was used')
    await fs.mkdir(p.outputDir, { recursive: true })
    const outFile = await uniquePath(p.outputDir, sanitizeFileName(p.settings.fileName), '.mp4')

    const attempt = (enc: 'cpu' | 'nvenc') =>
      runRender({
        ffmpeg: ffmpeg.path as string, ffprobe: ffprobe.path as string, project: p.project, projectDir: p.projectDir, settings: p.settings,
        encoder: enc, outFile, tempDir: path.join(p.prepDir, 'work'), subtitleImages: p.subtitleImages, blankImage: p.blankImage,
        onProgress: hooks.progress, signal: hooks.signal
      })
    hooks.status('rendering')
    let result
    try {
      result = await attempt(encoder)
    } catch (e) {
      if (e instanceof RenderCancelled || hooks.signal.aborted || encoder !== 'nvenc') throw e
      // GPU encoding can fail at run time (driver, session limits). Fall back to the CPU once.
      hooks.note('GPU encoding failed, so this export was finished on the CPU')
      hooks.progress(0)
      encoder = 'cpu'
      result = await attempt('cpu')
    }
    return { outputPath: result.outFile, encoder, verification: result.verification }
  },
  async (p) => void (await fs.rm(p.prepDir, { recursive: true, force: true }))
)

let exportPushTimer: NodeJS.Timeout | null = null
function pushExportUpdate(now = false): void {
  const send = () => {
    exportPushTimer = null
    mainWindow?.webContents.send('export:update', exportQueue.list())
  }
  if (now) {
    if (exportPushTimer) clearTimeout(exportPushTimer)
    return send()
  }
  if (!exportPushTimer) exportPushTimer = setTimeout(send, 150)
}
exportQueue.on('update', () => pushExportUpdate())
exportQueue.on('finished', (job: ExportJobInfo) => {
  pushExportUpdate(true)
  if (!Notification.isSupported() || (job.status !== 'done' && job.status !== 'failed')) return
  new Notification({
    title: job.status === 'done' ? 'Export finished' : 'Export failed',
    body: job.status === 'done' ? `${job.name} is ready.` : `${job.name}: ${job.error ?? 'Something went wrong'}`
  }).show()
})

const APP_URL = pathToFileURL(path.join(__dirname, '../../dist/index.html')).href
const ExistingSchema = z.array(z.object({ path: z.string().max(4096), pathKind: z.enum(['relative', 'absolute']) })).max(5000)
let mainWindow: BrowserWindow | null = null
let dirty = false

async function log(level: 'info' | 'error', message: string): Promise<void> {
  try {
    const dir = app.getPath('logs')
    await fs.mkdir(dir, { recursive: true })
    await fs.appendFile(path.join(dir, 'main.log'), `${new Date().toISOString()} [${level}] ${message}\n`)
  } catch {
    /* logging must never crash the app */
  }
}

function fail(error: string, cancelled = false): Result<never> {
  return { ok: false, error, ...(cancelled ? { cancelled: true } : {}) }
}

function friendlyError(e: unknown): string {
  if (e instanceof ZodError) return 'The project data is damaged or incomplete'
  return e instanceof Error ? e.message : 'Unexpected error'
}

/** Register an IPC handler that rejects foreign senders and validates input with zod. */
function handle<S extends z.ZodTypeAny, R>(
  channel: string,
  schema: S,
  fn: (input: z.infer<S>) => Promise<Result<R>>
): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return fail('Request rejected')
    const parsed = schema.safeParse(raw)
    if (!parsed.success) return fail('Invalid request')
    try {
      return await fn(parsed.data)
    } catch (e) {
      await log('error', `${channel}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
      return fail(friendlyError(e))
    }
  })
}

async function pickFolder(title: string): Promise<string | null> {
  const root = path.join(app.getPath('documents'), 'R0-BI Studio', 'projects')
  await fs.mkdir(root, { recursive: true })
  const opts = { title, defaultPath: root, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
  const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
  return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
}

function registerIpc(): void {
  handle('project:new', z.object({ name: z.string().trim().min(1).max(80) }), async ({ name }): Promise<Result<ProjectHandle>> => {
    const parent = await pickFolder('Choose where to create the project')
    if (!parent) return fail('Cancelled', true)
    const { project, dir } = await manager.create(parent, name)
    await log('info', `Created project at ${dir}`)
    return { ok: true, data: { project, dir } }
  })

  handle('project:open', z.undefined(), async (): Promise<Result<ProjectHandle>> => {
    const opts = {
      title: 'Open project',
      defaultPath: path.join(app.getPath('documents'), 'R0-BI Studio', 'projects'),
      filters: [{ name: 'R0-BI project', extensions: ['json'] }],
      properties: ['openFile' as const]
    }
    const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return fail('Cancelled', true)

    const opened = await manager.open(res.filePaths[0])
    let project: Project = opened.project
    let recovered = false
    if (opened.autosave) {
      const box = {
        type: 'question' as const,
        buttons: ['Recover unsaved changes', 'Open last saved version'],
        defaultId: 0,
        cancelId: 1,
        title: 'Recover project',
        message: 'This project has autosaved changes that were never saved.',
        detail: 'Recover them, or open the last version you saved.'
      }
      const choice = mainWindow ? dialog.showMessageBoxSync(mainWindow, box) : dialog.showMessageBoxSync(box)
      if (choice === 0) {
        project = opened.autosave
        recovered = true
      } else {
        await manager.discardAutosave()
      }
    }
    return { ok: true, data: { project, dir: opened.dir, recovered } }
  })

  handle('project:save', ProjectSchema, async (project): Promise<Result<Project>> => {
    const saved = await manager.save(project)
    return { ok: true, data: saved }
  })

  handle('project:saveAs', ProjectSchema, async (project): Promise<Result<ProjectHandle>> => {
    const parent = await pickFolder('Choose where to save the copy')
    if (!parent) return fail('Cancelled', true)
    const { project: saved, dir } = await manager.saveAs(parent, project)
    await log('info', `Saved project copy at ${dir}`)
    return { ok: true, data: { project: saved, dir } }
  })

  handle('project:autosave', ProjectSchema, async (project): Promise<Result<null>> => {
    await manager.autosave(project)
    return { ok: true, data: null }
  })

  const projectDir = (): string => {
    if (!manager.dir) throw new Error('No project is open')
    return manager.dir
  }
  const projectDirOrThrow = projectDir

  handle('media:toolStatus', z.undefined(), async (): Promise<Result<ToolStatus>> => ({ ok: true, data: await media.toolStatus() }))

  handle('media:importDialog', z.object({ existing: ExistingSchema }), async ({ existing }): Promise<Result<ImportResult>> => {
    const dir = projectDir()
    const exts = Object.keys(MEDIA_EXTENSIONS)
    const opts = {
      title: 'Import media',
      filters: [{ name: 'Video, audio and images', extensions: exts }],
      properties: ['openFile' as const, 'multiSelections' as const]
    }
    const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return fail('Cancelled', true)
    return { ok: true, data: await media.importFiles(dir, res.filePaths, existing) }
  })

  handle(
    'media:importPaths',
    z.object({ paths: z.array(z.string().max(4096)).min(1).max(1000), existing: ExistingSchema }),
    async ({ paths, existing }): Promise<Result<ImportResult>> => ({ ok: true, data: await media.importFiles(projectDir(), paths, existing) })
  )

  handle(
    'media:refresh',
    z.object({ assets: z.array(MediaAssetSchema).max(5000), haveThumbs: z.array(z.string()).max(5000) }),
    async ({ assets, haveThumbs }): Promise<Result<RefreshResult>> => {
      const dir = projectDir()
      registry.update(dir, assets) // the preview can only load files that are in the library
      return { ok: true, data: await media.refresh(dir, assets, haveThumbs) }
    }
  )

  handle('media:relink', MediaAssetSchema, async (asset): Promise<Result<RelinkResult>> => {
    const dir = projectDir()
    const opts = {
      title: `Locate "${asset.name}"`,
      filters: [{ name: 'Media', extensions: Object.keys(MEDIA_EXTENSIONS) }],
      properties: ['openFile' as const]
    }
    const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return fail('Cancelled', true)
    return { ok: true, data: await media.relink(dir, asset, res.filePaths[0]) }
  })

  handle('media:makeProxy', MediaAssetSchema, async (asset): Promise<Result<{ proxy: string }>> => ({
    ok: true,
    data: { proxy: await media.makeProxy(projectDir(), asset) }
  }))

  handle('media:waveforms', z.object({ assets: z.array(MediaAssetSchema).max(5000) }), async ({ assets }): Promise<Result<Record<string, string>>> => {
    const dir = projectDir()
    const out: Record<string, string> = {}
    await Promise.all(
      assets.map(async (a) => {
        const peaks = await media.waveform(dir, a).catch(() => null)
        if (peaks) out[a.id] = Buffer.from(peaks).toString('base64')
      })
    )
    return { ok: true, data: out }
  })

  handle('subtitles:importDialog', z.undefined(), async (): Promise<Result<SubtitleFile>> => {
    const opts = {
      title: 'Import subtitles',
      filters: [{ name: 'SubRip subtitles', extensions: ['srt'] }],
      properties: ['openFile' as const]
    }
    const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return fail('Cancelled', true)
    const file = res.filePaths[0]
    const stat = await fs.stat(file)
    if (stat.size > 5 * 1024 * 1024) return fail('That subtitle file is too large (over 5 MB)')
    return { ok: true, data: { name: path.basename(file), text: decodeSubtitleBytes(await fs.readFile(file)) } }
  })

  handle('media:cancelProxy', z.object({ id: z.string().min(1) }), async ({ id }): Promise<Result<null>> => {
    media.cancelProxy(id)
    return { ok: true, data: null }
  })

  handle('automation:load', z.undefined(), async (): Promise<Result<AutomationData>> => ({ ok: true, data: allLibraries() }))
  const KindSchema = z.enum(['templates', 'scenes', 'presets'])
  handle('automation:save', z.object({ kind: KindSchema, item: z.unknown() }), async ({ kind, item }): Promise<Result<AutomationData>> => {
    await libraries[kind].upsert(item)
    return { ok: true, data: allLibraries() }
  })
  handle('automation:remove', z.object({ kind: KindSchema, id: z.string().max(64) }), async ({ kind, id }): Promise<Result<AutomationData>> => {
    await libraries[kind].remove(id)
    return { ok: true, data: allLibraries() }
  })
  handle('automation:pickProjects', z.undefined(), async (): Promise<Result<BatchProject[]>> => {
    const opts = {
      title: 'Choose projects to export',
      defaultPath: path.join(app.getPath('documents'), 'R0-BI Studio', 'projects'),
      filters: [{ name: 'R0-BI project', extensions: ['json'] }],
      properties: ['openFile' as const, 'multiSelections' as const]
    }
    const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return fail('Cancelled', true)
    const out: BatchProject[] = []
    for (const file of res.filePaths.slice(0, 50)) {
      if (path.basename(file) !== 'project.json') continue
      const project = migrateProject(JSON.parse(await fs.readFile(file, 'utf8')))
      const token = randomUUID()
      batchProjects.set(token, path.dirname(file))
      out.push({ token, name: project.name, folder: path.dirname(file), project })
    }
    if (out.length === 0) return fail('Choose project.json files')
    return { ok: true, data: out }
  })

  handle('ai:getSettings', z.undefined(), async (): Promise<Result<AiStatus>> => ({ ok: true, data: aiSettings.status() }))

  handle(
    'ai:saveSettings',
    z.object({ model: z.string().max(80).optional(), key: z.string().max(500).nullable().optional() }),
    async (change): Promise<Result<AiStatus>> => {
      await aiSettings.save(change)
      return { ok: true, data: aiSettings.status() }
    }
  )

  handle('ai:test', z.undefined(), async (): Promise<Result<{ model: string }>> => {
    const apiKey = aiSettings.getKey()
    if (!apiKey) return fail('Add your API key first')
    const model = aiSettings.getModel()
    await pingModel({ apiKey, model })
    return { ok: true, data: { model } }
  })

  handle(
    'ai:plan',
    z.object({
      request: z.string().trim().min(1).max(4000),
      history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(2000) })).max(12),
      context: z.unknown(),
      thumbnails: z.array(z.object({ alias: z.string().max(20), mediaType: z.enum(['image/jpeg', 'image/png']), data: z.string().max(400_000) })).max(8)
    }),
    async ({ request, history, context, thumbnails }): Promise<Result<AiPlanResponse>> => {
      const apiKey = aiSettings.getKey()
      if (!apiKey) return fail('Add your Anthropic API key in Settings first')
      if (JSON.stringify(context).length > 250_000) return fail('The project is too large to send. Try working on a smaller part')
      if (thumbnails.reduce((n, t) => n + t.data.length, 0) > 2_000_000) return fail('The thumbnails are too large to send')
      if (aiAbort) return fail('The assistant is already working on a request')
      const model = aiSettings.getModel()
      aiAbort = new AbortController()
      try {
        const reply = await requestPlan({ apiKey, model, messages: buildMessages(history, request, context, thumbnails), signal: aiAbort.signal })
        void log('info', `AI plan ok (${model}, ${reply.usage.inputTokens} in / ${reply.usage.outputTokens} out)`)
        return { ok: true, data: { plan: reply.input, usage: reply.usage, model } }
      } catch (e) {
        if (e instanceof AiCancelled) return fail('Cancelled', true)
        throw e
      } finally {
        aiAbort = null
      }
    }
  )

  handle('ai:cancel', z.undefined(), async (): Promise<Result<null>> => {
    aiAbort?.abort()
    return { ok: true, data: null }
  })

  handle('export:info', z.undefined(), async (): Promise<Result<ExportInfo>> => {
    const ffmpeg = await getTool('ffmpeg')
    const nvenc = ffmpeg.path ? await detectNvenc(ffmpeg.path) : false
    return { ok: true, data: { nvenc, projectFolder: manager.dir ? path.join(manager.dir, 'exports') : null, customFolder: customOutputDir } }
  })

  handle('export:chooseFolder', z.undefined(), async (): Promise<Result<string>> => {
    const opts = { title: 'Choose where to save exported videos', properties: ['openDirectory' as const, 'createDirectory' as const] }
    const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return fail('Cancelled', true)
    customOutputDir = res.filePaths[0]
    return { ok: true, data: customOutputDir }
  })

  handle('export:prepare', z.undefined(), async (): Promise<Result<{ prepId: string }>> => {
    const prepId = randomUUID()
    const dir = path.join(EXPORT_TMP, prepId)
    await fs.mkdir(path.join(dir, 'subs'), { recursive: true })
    preps.set(prepId, dir)
    return { ok: true, data: { prepId } }
  })

  handle(
    'export:subtitleImages',
    z.object({ prepId: z.string().max(64), items: z.array(z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), data: z.string().max(40_000_000) })).max(100) }),
    async ({ prepId, items }): Promise<Result<null>> => {
      const dir = preps.get(prepId)
      if (!dir) return fail('Export preparation expired. Try again')
      for (const it of items) await fs.writeFile(path.join(dir, 'subs', `${it.key}.png`), Buffer.from(it.data, 'base64'))
      return { ok: true, data: null }
    }
  )

  handle(
    'export:enqueue',
    z.object({ prepId: z.string().max(64), project: ProjectSchema, settings: ExportSettingsSchema, cueImages: z.record(z.string().max(64), z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)), projectToken: z.string().max(64).optional() }),
    async ({ prepId, project, settings, cueImages, projectToken }): Promise<Result<ExportJobInfo>> => {
      const prepDir = preps.get(prepId)
      if (!prepDir) return fail('Export preparation expired. Try again')
      preps.delete(prepId)
      let projectDir: string
      if (projectToken !== undefined) {
        const known = batchProjects.get(projectToken)
        if (!known) return fail('That project is no longer available. Pick it again')
        projectDir = known
      } else projectDir = projectDirOrThrow()
      let outputDir: string
      if (settings.outputDir === 'custom') {
        if (!customOutputDir) return fail('Choose an output folder first')
        outputDir = customOutputDir
      } else {
        outputDir = path.join(projectDir, 'exports')
      }
      const subtitleImages: Record<string, string> = {}
      for (const [cueId, key] of Object.entries(cueImages)) {
        const file = path.join(prepDir, 'subs', `${key}.png`)
        try {
          await fs.access(file)
          subtitleImages[cueId] = file
        } catch {
          return fail('Some subtitle images are missing. Try the export again')
        }
      }
      const blank = path.join(prepDir, 'subs', 'blank.png')
      const hasBlank = await fs.access(blank).then(() => true, () => false)
      const seconds = Math.max(0, ...project.clips.map((c) => c.startFrame + c.durationFrames), ...project.subtitles.map((c) => c.startFrame + c.durationFrames)) / project.settings.fps
      const job = exportQueue.enqueue(settings.fileName, seconds, { project, projectDir, settings, prepDir, subtitleImages, blankImage: hasBlank ? blank : null, outputDir })
      return { ok: true, data: job }
    }
  )

  handle('export:list', z.undefined(), async (): Promise<Result<ExportJobInfo[]>> => ({ ok: true, data: exportQueue.list() }))
  handle('export:cancel', z.object({ id: z.string().max(64) }), async ({ id }): Promise<Result<null>> => (exportQueue.cancel(id) ? { ok: true, data: null } : fail('That export is not running')))
  handle('export:clear', z.undefined(), async (): Promise<Result<null>> => (exportQueue.clearFinished(), { ok: true, data: null }))
  handle('export:reveal', z.object({ id: z.string().max(64) }), async ({ id }): Promise<Result<null>> => {
    const job = exportQueue.get(id)
    if (!job?.outputPath) return fail('That file is not available')
    shell.showItemInFolder(job.outputPath)
    return { ok: true, data: null }
  })

  ipcMain.on('app:set-dirty', (event, value: unknown) => {
    if (mainWindow && event.sender === mainWindow.webContents) dirty = value === true
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#14161a',
    title: 'R0-BI Studio',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  mainWindow = win

  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = isDev ? url.startsWith(DEV_URL as string) : url.startsWith(APP_URL)
    if (!allowed) e.preventDefault()
  })
  win.on('close', (e) => {
    const active = exportQueue.list().some((j) => j.status === 'queued' || j.status === 'preparing' || j.status === 'rendering' || j.status === 'verifying')
    if (active) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning', buttons: ['Keep exporting', 'Quit and cancel exports'], defaultId: 0, cancelId: 0,
        title: 'Export in progress', message: 'A video is still being exported.', detail: 'Quitting now cancels it and the unfinished file is deleted.'
      })
      if (choice === 0) return e.preventDefault()
    }
    if (!dirty) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Cancel', 'Close without saving'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved changes',
      message: 'You have unsaved changes.',
      detail: 'An autosaved recovery copy is kept, and you can recover it the next time you open this project.'
    })
    if (choice === 0) e.preventDefault()
  })
  win.on('closed', () => {
    mainWindow = null
  })

  if (isDev) void win.loadURL(DEV_URL as string)
  else void win.loadFile(path.join(__dirname, '../../dist/index.html'))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.whenReady().then(async () => {
    if (!isDev) Menu.setApplicationMenu(null)
    protocol.handle(MEDIA_SCHEME, (req) => handleMediaRequest(registry, req))
    await aiSettings.load()
    await Promise.all(Object.values(libraries).map((l) => l.load()))
    registerIpc()
    createWindow()
    void log('info', `R0-BI Studio ${app.getVersion()} started`)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  app.on('before-quit', () => {
    for (const j of exportQueue.list()) exportQueue.cancel(j.id)
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
