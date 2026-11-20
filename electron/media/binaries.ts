import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import type { ToolInfo } from '../../shared/api'

export type ToolName = 'ffmpeg' | 'ffprobe'
export interface ResolvedTool extends ToolInfo {
  path: string | null
}

const cache = new Map<ToolName, Promise<ResolvedTool>>()
const nodeRequire = createRequire(__filename)

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
  })
}

async function versionOf(file: string): Promise<string | null> {
  try {
    const out = await run(file, ['-version'])
    const m = /version\s+(\S+)/.exec(out.split('\n')[0] ?? '')
    return m ? m[1] : 'unknown'
  } catch {
    return null
  }
}

function bundledPath(name: ToolName): string | null {
  try {
    const pkg = name === 'ffmpeg' ? '@ffmpeg-installer/ffmpeg' : '@ffprobe-installer/ffprobe'
    const p: string = nodeRequire(pkg).path
    // Inside a packaged app the binary lives outside the asar archive.
    return p.replace('app.asar', 'app.asar.unpacked')
  } catch {
    return null
  }
}

async function resolve(name: ToolName): Promise<ResolvedTool> {
  const envPath = process.env[name === 'ffmpeg' ? 'R0BI_FFMPEG' : 'R0BI_FFPROBE']
  const candidates: { path: string; source: 'env' | 'path' | 'bundled' }[] = []
  if (envPath) candidates.push({ path: envPath, source: 'env' })
  candidates.push({ path: name, source: 'path' }) // system install on PATH wins over the bundled build
  const bundled = bundledPath(name)
  if (bundled) candidates.push({ path: bundled, source: 'bundled' })

  for (const c of candidates) {
    const version = await versionOf(c.path)
    if (version) return { found: true, version, source: c.source, path: c.path }
  }
  return { found: false, version: null, source: null, path: null }
}

export function getTool(name: ToolName): Promise<ResolvedTool> {
  let p = cache.get(name)
  if (!p) {
    p = resolve(name)
    cache.set(name, p)
  }
  return p
}

export function resetToolCache(): void {
  cache.clear()
}
