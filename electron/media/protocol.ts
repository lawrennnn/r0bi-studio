import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { MediaAsset } from '../../shared/project'
import { resolveAssetPath } from './mediaService'

export const MEDIA_SCHEME = 'r0bi-media'

const MIME: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  wav: 'audio/wav', mp3: 'audio/mpeg', aac: 'audio/aac', m4a: 'audio/mp4'
}
export const mimeFor = (file: string): string => MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream'

/** Parse a single HTTP byte range. null = no usable range (serve whole file); 'invalid' = 416. */
export function parseRange(header: string, size: number): { start: number; end: number } | 'invalid' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null // also covers multi-range, which we do not support
  let start: number
  let end: number
  if (m[1] === '') {
    const n = Number(m[2]) // suffix: last n bytes
    if (n === 0) return 'invalid'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return 'invalid'
  return { start, end }
}

/** Serve a local file with HTTP range support so <video> can seek. */
export async function serveFile(file: string, rangeHeader: string | null, method = 'GET'): Promise<Response> {
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile()) return new Response(null, { status: 404 })
  const size = stat.size
  const headers: Record<string, string> = { 'Content-Type': mimeFor(file), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
  if (size === 0) return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': '0' } })

  let start = 0
  let end = size - 1
  let status = 200
  if (rangeHeader) {
    const r = parseRange(rangeHeader, size)
    if (r === 'invalid') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    if (r) {
      ;({ start, end } = r)
      status = 206
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    }
  }
  headers['Content-Length'] = String(end - start + 1)
  if (method === 'HEAD') return new Response(null, { status, headers })
  const body = Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream
  return new Response(body, { status, headers })
}

/** Only files that belong to the open project's media library can be served. */
export class MediaRegistry {
  private dir = ''
  private assets = new Map<string, MediaAsset>()

  update(projectDir: string, assets: readonly MediaAsset[]): void {
    this.dir = projectDir
    this.assets = new Map(assets.map((a) => [a.id, a]))
  }

  resolve(kind: string, id: string): string | null {
    const asset = this.assets.get(id)
    if (!asset) return null
    if (kind === 'asset') return resolveAssetPath(this.dir, asset)
    if (kind === 'proxy' && asset.proxy) return resolveAssetPath(this.dir, { path: asset.proxy, pathKind: 'relative' })
    return null
  }
}

export function handleMediaRequest(registry: MediaRegistry, req: { url: string; method: string; headers: { get(name: string): string | null } }): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return Promise.resolve(new Response(null, { status: 405 }))
  let kind: string
  let id: string
  try {
    const url = new URL(req.url)
    kind = url.hostname
    id = decodeURIComponent(url.pathname.replace(/^\//, ''))
  } catch {
    return Promise.resolve(new Response(null, { status: 400 }))
  }
  const file = registry.resolve(kind, id)
  if (!file) return Promise.resolve(new Response(null, { status: 404 }))
  return serveFile(file, req.headers.get('range'), req.method)
}
