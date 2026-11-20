import fs from 'node:fs/promises'
import path from 'node:path'
import type { ZodType } from 'zod'

const MAX_ITEMS = 500

/**
 * A small JSON file of saved items (templates, scenes or presets) in the app's data folder.
 * Items that do not match their schema are dropped on load, so a damaged file never blocks the app.
 */
export class JsonLibrary<T extends { id: string }> {
  private items: T[] = []
  constructor(
    private file: string,
    private schema: ZodType<T>
  ) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown
      this.items = Array.isArray(raw) ? raw.flatMap((x) => { const r = this.schema.safeParse(x); return r.success ? [r.data] : [] }) : []
    } catch {
      this.items = []
    }
  }

  list(): T[] {
    return this.items.map((x) => structuredClone(x))
  }

  private async persist(items: T[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(items, null, 2), 'utf8')
    await fs.rename(tmp, this.file)
    this.items = items
  }

  /** Add an item, or replace the one with the same id. */
  async upsert(item: unknown): Promise<T> {
    const parsed = this.schema.safeParse(item)
    if (!parsed.success) throw new Error('That item is not valid and was not saved')
    const next = this.items.filter((x) => x.id !== parsed.data.id)
    if (next.length >= MAX_ITEMS) throw new Error(`The library is full (${MAX_ITEMS} items). Delete some first`)
    next.push(parsed.data)
    await this.persist(next)
    return structuredClone(parsed.data)
  }

  async remove(id: string): Promise<boolean> {
    const next = this.items.filter((x) => x.id !== id)
    if (next.length === this.items.length) return false
    await this.persist(next)
    return true
  }
}
