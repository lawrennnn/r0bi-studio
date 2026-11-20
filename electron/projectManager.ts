import fs from 'node:fs/promises'
import path from 'node:path'
import { createEmptyProject, migrateProject, ProjectSchema, type Project } from '../shared/project'

export const PROJECT_FILE = 'project.json'
export const AUTOSAVE_FILE = 'autosave.json'
export const SUBDIRS = [
  'assets/video',
  'assets/audio',
  'assets/images',
  'assets/subtitles',
  'assets/thumbnails',
  'assets/proxies',
  'assets/waveforms',
  'exports',
  'backups'
]
const MAX_BACKUPS = 10
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function sanitizeFolderName(name: string): string {
  let s = name
    .trim()
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[. ]+$/, '')
  if (RESERVED.test(s)) s = `_${s}`
  return s || 'untitled'
}

/** Like sanitizeFolderName but keeps spaces, for readable exported file names. */
export function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let s = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').replace(/[. ]+$/, '')
  if (RESERVED.test(s)) s = `_${s}`
  return s || 'export'
}

async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, data, 'utf8')
  await fs.rename(tmp, file)
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export interface OpenResult {
  project: Project
  dir: string
  /** Present when an autosave newer than project.json exists and is valid. */
  autosave: Project | null
}

export class ProjectManager {
  dir: string | null = null

  private requireDir(): string {
    if (!this.dir) throw new Error('No project is open')
    return this.dir
  }

  private async scaffold(folder: string): Promise<void> {
    for (const sub of SUBDIRS) await fs.mkdir(path.join(folder, sub), { recursive: true })
  }

  private async assertFreshFolder(folder: string): Promise<void> {
    try {
      const entries = await fs.readdir(folder)
      if (entries.length > 0) throw new Error('A folder with that name already exists and is not empty')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }

  async create(parentDir: string, name: string): Promise<{ project: Project; dir: string }> {
    const folder = path.join(parentDir, sanitizeFolderName(name))
    await this.assertFreshFolder(folder)
    await this.scaffold(folder)
    const project = createEmptyProject(name)
    await atomicWrite(path.join(folder, PROJECT_FILE), JSON.stringify(project, null, 2))
    this.dir = folder
    return { project, dir: folder }
  }

  async open(file: string): Promise<OpenResult> {
    if (path.basename(file) !== PROJECT_FILE) throw new Error(`Choose a ${PROJECT_FILE} file`)
    const dir = path.dirname(file)
    const project = migrateProject(JSON.parse(await fs.readFile(file, 'utf8')))
    await this.scaffold(dir) // restore any missing standard folders
    this.dir = dir

    let autosave: Project | null = null
    const autoFile = path.join(dir, 'backups', AUTOSAVE_FILE)
    try {
      const [a, p] = await Promise.all([fs.stat(autoFile), fs.stat(file)])
      if (a.mtimeMs > p.mtimeMs) {
        autosave = migrateProject(JSON.parse(await fs.readFile(autoFile, 'utf8')))
      }
    } catch {
      autosave = null // no autosave, or unreadable: ignore
    }
    return { project, dir, autosave }
  }

  async discardAutosave(): Promise<void> {
    await fs.rm(path.join(this.requireDir(), 'backups', AUTOSAVE_FILE), { force: true })
  }

  async save(project: Project): Promise<Project> {
    const dir = this.requireDir()
    const valid = ProjectSchema.parse(project)
    const file = path.join(dir, PROJECT_FILE)
    const backups = path.join(dir, 'backups')
    await fs.mkdir(backups, { recursive: true })

    if (await exists(file)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      let target = path.join(backups, `project-${stamp}.json`)
      for (let n = 1; await exists(target); n++) target = path.join(backups, `project-${stamp}_${n}.json`)
      await fs.copyFile(file, target)
      await this.pruneBackups(backups)
    }
    const updated: Project = { ...valid, updatedAt: new Date().toISOString() }
    await atomicWrite(file, JSON.stringify(updated, null, 2))
    await this.discardAutosave()
    return updated
  }

  async autosave(project: Project): Promise<void> {
    const dir = this.requireDir()
    const valid = ProjectSchema.parse(project)
    await fs.mkdir(path.join(dir, 'backups'), { recursive: true })
    await atomicWrite(path.join(dir, 'backups', AUTOSAVE_FILE), JSON.stringify(valid, null, 2))
  }

  /** Copy the project (and its relative-path assets) to a new folder and switch to it. */
  async saveAs(parentDir: string, project: Project): Promise<{ project: Project; dir: string }> {
    const current = this.requireDir()
    const valid = ProjectSchema.parse(project)
    const folder = path.join(parentDir, sanitizeFolderName(valid.name))
    if (path.resolve(folder) === path.resolve(current)) throw new Error('Choose a different folder')
    await this.assertFreshFolder(folder)
    await this.scaffold(folder)
    const assets = path.join(current, 'assets')
    if (await exists(assets)) await fs.cp(assets, path.join(folder, 'assets'), { recursive: true })
    const updated: Project = { ...valid, updatedAt: new Date().toISOString() }
    await atomicWrite(path.join(folder, PROJECT_FILE), JSON.stringify(updated, null, 2))
    this.dir = folder
    return { project: updated, dir: folder }
  }

  private async pruneBackups(backups: string): Promise<void> {
    const names = (await fs.readdir(backups)).filter((n) => /^project-.*\.json$/.test(n)).sort()
    for (const old of names.slice(0, Math.max(0, names.length - MAX_BACKUPS))) {
      await fs.rm(path.join(backups, old), { force: true })
    }
  }
}
