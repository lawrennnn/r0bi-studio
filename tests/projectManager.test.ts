import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProjectManager, sanitizeFileName, sanitizeFolderName, SUBDIRS } from '../electron/projectManager'

let root: string
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'r0bi-')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

describe('ProjectManager', () => {
  it('creates the standard folder structure and project.json', async () => {
    const m = new ProjectManager()
    const { dir, project } = await m.create(root, 'Episode 001')
    for (const sub of SUBDIRS) expect((await fs.stat(path.join(dir, sub))).isDirectory()).toBe(true)
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8'))
    expect(onDisk.id).toBe(project.id)
  })

  it('refuses to overwrite a non-empty folder', async () => {
    const m = new ProjectManager()
    await m.create(root, 'Dup')
    await expect(new ProjectManager().create(root, 'Dup')).rejects.toThrow(/already exists/)
  })

  it('saves, keeps backups, and reopens', async () => {
    const m = new ProjectManager()
    const { dir, project } = await m.create(root, 'Save Me')
    const saved = await m.save({ ...project, name: 'Save Me 2' })
    expect(saved.name).toBe('Save Me 2')
    const backups = (await fs.readdir(path.join(dir, 'backups'))).filter((n) => n.startsWith('project-'))
    expect(backups.length).toBe(1)

    const reopened = await new ProjectManager().open(path.join(dir, 'project.json'))
    expect(reopened.project.name).toBe('Save Me 2')
    expect(reopened.autosave).toBeNull()
  })

  it('prunes old backups to the most recent 10', async () => {
    const m = new ProjectManager()
    const { project } = await m.create(root, 'Many')
    for (let i = 0; i < 14; i++) await m.save({ ...project, name: `Many ${i}` })
    const dir = m.dir!
    const backups = (await fs.readdir(path.join(dir, 'backups'))).filter((n) => n.startsWith('project-'))
    expect(backups.length).toBe(10)
  })

  it('offers a newer autosave for recovery and clears it on save', async () => {
    const m = new ProjectManager()
    const { dir, project } = await m.create(root, 'Recover')
    await new Promise((r) => setTimeout(r, 20))
    await m.autosave({ ...project, name: 'Unsaved edit' })

    const opened = await new ProjectManager().open(path.join(dir, 'project.json'))
    expect(opened.project.name).toBe('Recover')
    expect(opened.autosave?.name).toBe('Unsaved edit')

    await m.save({ ...project, name: 'Saved' })
    const after = await new ProjectManager().open(path.join(dir, 'project.json'))
    expect(after.autosave).toBeNull()
  })

  it('saves a copy including assets and switches to it', async () => {
    const m = new ProjectManager()
    const { dir, project } = await m.create(root, 'Original')
    await fs.writeFile(path.join(dir, 'assets/video/clip.txt'), 'x')
    const copyParent = path.join(root, 'copies')
    await fs.mkdir(copyParent)
    const copy = await m.saveAs(copyParent, { ...project, name: 'Copy' })
    expect(await fs.readFile(path.join(copy.dir, 'assets/video/clip.txt'), 'utf8')).toBe('x')
    expect(m.dir).toBe(copy.dir)
  })

  it('rejects a damaged project file and a wrong file name', async () => {
    const m = new ProjectManager()
    const { dir } = await m.create(root, 'Bad')
    await fs.writeFile(path.join(dir, 'project.json'), '{"schemaVersion":1}')
    await expect(new ProjectManager().open(path.join(dir, 'project.json'))).rejects.toThrow()
    await expect(new ProjectManager().open(path.join(dir, 'other.json'))).rejects.toThrow(/project\.json/)
  })

  it('requires an open project to save', async () => {
    const m = new ProjectManager()
    const { project } = await new ProjectManager().create(root, 'X')
    await expect(m.save(project)).rejects.toThrow(/No project is open/)
  })
})

describe('sanitizeFolderName', () => {
  it('removes illegal and reserved Windows names', () => {
    expect(sanitizeFolderName('a<b>:c/d')).toBe('abcd')
    expect(sanitizeFolderName('CON')).toBe('_CON')
    expect(sanitizeFolderName('Ep 1. ')).toBe('Ep-1')
    expect(sanitizeFolderName('???')).toBe('untitled')
  })
})

describe('sanitizeFileName', () => {
  it('keeps readable spaces but removes illegal characters and reserved names', () => {
    expect(sanitizeFileName('Episode 001: Meet R0-BI?')).toBe('Episode 001 Meet R0-BI')
    expect(sanitizeFileName('  ..  ')).toBe('export')
    expect(sanitizeFileName('NUL')).toBe('_NUL')
    expect(sanitizeFileName('វីដេអូ ១')).toBe('វីដេអូ ១')
  })
})
