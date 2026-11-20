import fs from 'node:fs/promises'
import path from 'node:path'
import type { AiStatus } from '../../shared/api'

/** Encrypts the key at rest. In the app this is Electron's safeStorage (Windows DPAPI). */
export interface Cipher {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export type { AiStatus }
import { AI_DEFAULT_MODEL } from '../../shared/ai'
export const DEFAULT_MODEL = AI_DEFAULT_MODEL

interface FileShape {
  model?: string
  keyCipher?: string | null
  keyHint?: string | null
}

const KEY_RE = /^[\x21-\x7e]{20,400}$/ // printable, no spaces
const MODEL_RE = /^[A-Za-z0-9._:-]{3,80}$/

export function hintFor(key: string): string {
  return `${key.slice(0, 7)}…${key.slice(-4)}`
}

/**
 * The AI settings file. The API key lives only here, encrypted, in the app's private data folder:
 * never in a project file, never sent to the page.
 */
export class AiSettings {
  private data: FileShape = {}
  constructor(
    private file: string,
    private cipher: Cipher
  ) {}

  async load(): Promise<void> {
    try {
      this.data = JSON.parse(await fs.readFile(this.file, 'utf8')) as FileShape
    } catch {
      this.data = {}
    }
  }

  getKey(): string | null {
    if (!this.data.keyCipher || !this.cipher.isAvailable()) return null
    try {
      return this.cipher.decrypt(Buffer.from(this.data.keyCipher, 'base64'))
    } catch {
      return null // saved by another Windows user or a broken profile
    }
  }

  getModel(): string {
    return this.data.model && MODEL_RE.test(this.data.model) ? this.data.model : DEFAULT_MODEL
  }

  status(): AiStatus {
    const hasKey = this.getKey() !== null
    return { hasKey, keyHint: hasKey ? (this.data.keyHint ?? null) : null, model: this.getModel(), encryptionAvailable: this.cipher.isAvailable() }
  }

  /** key: a string saves it, null removes it, undefined leaves it alone. */
  async save(change: { model?: string; key?: string | null }): Promise<void> {
    const next: FileShape = { ...this.data }
    if (change.model !== undefined) {
      if (!MODEL_RE.test(change.model)) throw new Error('That model name is not valid')
      next.model = change.model
    }
    if (change.key === null) {
      next.keyCipher = null
      next.keyHint = null
    } else if (change.key !== undefined) {
      const key = change.key.trim()
      if (!KEY_RE.test(key)) throw new Error('That does not look like an API key')
      if (!this.cipher.isAvailable()) throw new Error('Secure storage is not available on this computer, so the key cannot be saved safely')
      next.keyCipher = this.cipher.encrypt(key).toString('base64')
      next.keyHint = hintFor(key)
    }
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
    await fs.rename(tmp, this.file)
    this.data = next
  }
}
