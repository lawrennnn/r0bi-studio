import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { JsonLibrary } from '../electron/automation/library'
import { BUILTIN_PRESETS, PresetSchema, type Preset } from '../shared/automation'

let dir: string
let file: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'r0bi-lib-'))
  file = path.join(dir, 'sub', 'presets.json')
})
afterEach(async () => fs.rm(dir, { recursive: true, force: true }))

const preset = (id: string, name = id): Preset => ({ ...BUILTIN_PRESETS[0], id, name })

describe('JsonLibrary', () => {
  it('starts empty, saves, replaces by id, removes, and survives a restart', async () => {
    const lib = new JsonLibrary<Preset>(file, PresetSchema)
    await lib.load()
    expect(lib.list()).toEqual([])
    await lib.upsert(preset('a'))
    await lib.upsert(preset('b'))
    await lib.upsert(preset('a', 'Renamed'))
    expect(lib.list().map((p) => p.name)).toEqual(['b', 'Renamed'])
    expect(await lib.remove('b')).toBe(true)
    expect(await lib.remove('nope')).toBe(false)
    const again = new JsonLibrary<Preset>(file, PresetSchema)
    await again.load()
    expect(again.list().map((p) => p.id)).toEqual(['a'])
    await expect(fs.access(`${file}.tmp`)).rejects.toThrow()
  })
  it('rejects invalid items without changing anything, and returns copies', async () => {
    const lib = new JsonLibrary<Preset>(file, PresetSchema)
    await lib.load()
    await expect(lib.upsert({ id: 'x', name: '', resolution: '9000p' })).rejects.toThrow(/not valid/)
    expect(lib.list()).toEqual([])
    await lib.upsert(preset('a'))
    lib.list()[0].name = 'tampered'
    expect(lib.list()[0].name).toBe('a')
  })
  it('drops damaged entries and ignores a corrupt or wrong-shaped file', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify([preset('ok'), { id: 'bad' }, 'junk']))
    const lib = new JsonLibrary<Preset>(file, PresetSchema)
    await lib.load()
    expect(lib.list().map((p) => p.id)).toEqual(['ok'])
    await fs.writeFile(file, '{not json')
    await lib.load()
    expect(lib.list()).toEqual([])
    await fs.writeFile(file, '{"a":1}')
    await lib.load()
    expect(lib.list()).toEqual([])
    void z
  })
})
