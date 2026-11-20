import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { ExportJobInfo, ExportJobStatus, ExportVerification } from '../../shared/api'
import { RenderCancelled } from './renderer'

export type JobStatus = ExportJobStatus
export type { ExportJobInfo }

export interface WorkerHooks {
  status(s: JobStatus): void
  progress(fraction: number): void
  note(text: string): void
  signal: AbortSignal
}
export interface WorkerResult {
  outputPath: string
  encoder: 'cpu' | 'nvenc'
  verification: ExportVerification | null
}
export type Worker<P> = (payload: P, hooks: WorkerHooks) => Promise<WorkerResult>

interface Entry<P> {
  info: ExportJobInfo
  payload: P
  abort: AbortController
}

/** Runs export jobs one at a time. Events: "update" (list of jobs) and "finished" (one job). */
export class ExportQueue<P> extends EventEmitter {
  private entries: Entry<P>[] = []
  private busy = false

  constructor(
    private worker: Worker<P>,
    private cleanup: (payload: P) => Promise<void> = async () => undefined
  ) {
    super()
  }

  list(): ExportJobInfo[] {
    return this.entries.map((e) => ({ ...e.info }))
  }

  private changed(): void {
    this.emit('update', this.list())
  }

  enqueue(name: string, seconds: number, payload: P): ExportJobInfo {
    const info: ExportJobInfo = {
      id: randomUUID(), name, status: 'queued', progress: 0, outputPath: null, error: null, note: null,
      encoder: null, seconds, createdAt: Date.now(), startedAt: null, finishedAt: null, verification: null
    }
    this.entries.push({ info, payload, abort: new AbortController() })
    this.changed()
    void this.pump()
    return { ...info }
  }

  cancel(id: string): boolean {
    const e = this.entries.find((x) => x.info.id === id)
    if (!e) return false
    if (e.info.status === 'queued') {
      e.info.status = 'cancelled'
      e.info.finishedAt = Date.now()
      void this.cleanup(e.payload).catch(() => undefined)
      this.changed()
      this.emit('finished', { ...e.info })
      return true
    }
    if (e.info.status === 'preparing' || e.info.status === 'rendering' || e.info.status === 'verifying') {
      e.abort.abort()
      return true
    }
    return false
  }

  /** Remove finished, failed and cancelled jobs from the list. */
  clearFinished(): void {
    this.entries = this.entries.filter((e) => e.info.status === 'queued' || e.info.status === 'preparing' || e.info.status === 'rendering' || e.info.status === 'verifying')
    this.changed()
  }

  get(id: string): ExportJobInfo | undefined {
    const e = this.entries.find((x) => x.info.id === id)
    return e ? { ...e.info } : undefined
  }

  private async pump(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      for (let next = this.entries.find((e) => e.info.status === 'queued'); next; next = this.entries.find((e) => e.info.status === 'queued')) {
        await this.run(next)
      }
    } finally {
      this.busy = false
    }
  }

  private async run(e: Entry<P>): Promise<void> {
    const { info } = e
    info.status = 'preparing'
    info.startedAt = Date.now()
    this.changed()
    try {
      const result = await this.worker(e.payload, {
        signal: e.abort.signal,
        status: (s) => {
          info.status = s
          this.changed()
        },
        progress: (f) => {
          info.progress = Math.min(1, Math.max(0, f))
          this.changed()
        },
        note: (text) => {
          info.note = text
          this.changed()
        }
      })
      info.status = 'done'
      info.progress = 1
      info.outputPath = result.outputPath
      info.encoder = result.encoder
      info.verification = result.verification
    } catch (err) {
      if (err instanceof RenderCancelled || e.abort.signal.aborted) {
        info.status = 'cancelled'
      } else {
        info.status = 'failed'
        info.error = err instanceof Error ? err.message : 'Export failed'
      }
    } finally {
      info.finishedAt = Date.now()
      await this.cleanup(e.payload).catch(() => undefined)
      this.changed()
      this.emit('finished', { ...info })
    }
  }
}
