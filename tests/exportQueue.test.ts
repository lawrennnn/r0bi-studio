import { describe, expect, it } from 'vitest'
import { ExportQueue, type ExportJobInfo, type Worker } from '../electron/export/queue'
import { RenderCancelled } from '../electron/export/renderer'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (fn: () => boolean) => { for (let i = 0; i < 200 && !fn(); i++) await wait(10) }
const ok = { outputPath: '/out.mp4', encoder: 'cpu' as const, verification: null }

describe('ExportQueue', () => {
  it('runs jobs one at a time, in order, reporting progress and completion', async () => {
    const order: string[] = []
    let active = 0
    let maxActive = 0
    const worker: Worker<string> = async (name, h) => {
      active++
      maxActive = Math.max(maxActive, active)
      order.push(`start ${name}`)
      h.status('rendering')
      h.progress(0.5)
      await wait(15)
      active--
      return ok
    }
    const q = new ExportQueue<string>(worker)
    const finished: ExportJobInfo[] = []
    q.on('finished', (j) => finished.push(j))
    q.enqueue('a', 1, 'a')
    q.enqueue('b', 1, 'b')
    await until(() => finished.length === 2)
    expect(order).toEqual(['start a', 'start b'])
    expect(maxActive).toBe(1)
    expect(q.list().map((j) => [j.name, j.status, j.progress, j.outputPath])).toEqual([['a', 'done', 1, '/out.mp4'], ['b', 'done', 1, '/out.mp4']])
  })

  it('records a failure with its message and carries on with the next job', async () => {
    const worker: Worker<string> = async (name) => {
      if (name === 'bad') throw new Error('FFmpeg could not render the video')
      return ok
    }
    const q = new ExportQueue<string>(worker)
    q.enqueue('bad', 1, 'bad')
    q.enqueue('good', 1, 'good')
    await until(() => q.list().every((j) => j.status === 'done' || j.status === 'failed'))
    expect(q.list().map((j) => j.status)).toEqual(['failed', 'done'])
    expect(q.list()[0].error).toMatch(/could not render/)
  })

  it('cancels a queued job immediately and a running job through its abort signal', async () => {
    const cleaned: string[] = []
    const worker: Worker<string> = (name, h) =>
      new Promise((resolve, reject) => {
        h.status('rendering')
        h.signal.addEventListener('abort', () => reject(new RenderCancelled()))
        if (name === 'quick') setTimeout(() => resolve(ok), 5)
      })
    const q = new ExportQueue<string>(worker, async (p) => void cleaned.push(p))
    const running = q.enqueue('long', 1, 'long')
    const queued = q.enqueue('waiting', 1, 'waiting')
    await until(() => q.get(running.id)?.status === 'rendering')
    expect(q.cancel(queued.id)).toBe(true)
    expect(q.get(queued.id)?.status).toBe('cancelled')
    expect(q.cancel(running.id)).toBe(true)
    await until(() => q.get(running.id)?.status === 'cancelled')
    expect(q.get(running.id)?.status).toBe('cancelled')
    expect(cleaned.sort()).toEqual(['long', 'waiting'])
    expect(q.cancel('nope')).toBe(false)
    expect(q.cancel(running.id)).toBe(false) // already finished
  })

  it('clears only finished jobs and passes notes through', async () => {
    const worker: Worker<string> = async (name, h) => {
      h.note('retried on CPU')
      if (name === 'hold') await wait(80)
      return ok
    }
    const q = new ExportQueue<string>(worker)
    q.enqueue('one', 1, 'one')
    q.enqueue('hold', 1, 'hold')
    await until(() => q.list()[0].status === 'done')
    q.clearFinished()
    expect(q.list().map((j) => j.name)).toEqual(['hold'])
    expect(q.list()[0].note).toBe('retried on CPU')
    await until(() => q.list()[0].status === 'done')
  })
})
