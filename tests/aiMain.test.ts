import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AiSettings, DEFAULT_MODEL, type Cipher } from '../electron/ai/settings'
import { AiCancelled, API_URL, friendlyApiError, pingModel, requestPlan } from '../electron/ai/client'
import { AI_TOOL } from '../shared/ai'

const KEY = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ-1234'
const fakeCipher = (available = true): Cipher => ({
  isAvailable: () => available,
  encrypt: (s) => Buffer.from(`ENC:${[...s].reverse().join('')}`),
  decrypt: (b) => {
    const t = b.toString()
    if (!t.startsWith('ENC:')) throw new Error('bad')
    return [...t.slice(4)].reverse().join('')
  }
})

let dir: string
let file: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'r0bi-ai-'))
  file = path.join(dir, 'ai-settings.json')
})
afterEach(async () => fs.rm(dir, { recursive: true, force: true }))

describe('AI settings (API key storage)', () => {
  it('starts empty with the default model', async () => {
    const s = new AiSettings(file, fakeCipher())
    await s.load()
    expect(s.status()).toEqual({ hasKey: false, keyHint: null, model: DEFAULT_MODEL, encryptionAvailable: true })
    expect(s.getKey()).toBeNull()
  })
  it('stores the key encrypted, never in plain text, and survives a restart', async () => {
    const s = new AiSettings(file, fakeCipher())
    await s.load()
    await s.save({ key: KEY, model: 'claude-haiku-5-5' })
    const raw = await fs.readFile(file, 'utf8')
    expect(raw).not.toContain(KEY)
    expect(raw).not.toContain(KEY.slice(10, 30))
    const again = new AiSettings(file, fakeCipher())
    await again.load()
    expect(again.getKey()).toBe(KEY)
    expect(again.status()).toMatchObject({ hasKey: true, model: 'claude-haiku-5-5', keyHint: 'sk-ant-…1234' })
    expect(JSON.stringify(again.status())).not.toContain(KEY)
  })
  it('refuses to save a key when the computer cannot encrypt, and rejects bad input', async () => {
    const s = new AiSettings(file, fakeCipher(false))
    await s.load()
    await expect(s.save({ key: KEY })).rejects.toThrow(/Secure storage/)
    await expect(new AiSettings(file, fakeCipher()).save({ key: 'short' })).rejects.toThrow(/API key/)
    await expect(new AiSettings(file, fakeCipher()).save({ key: 'has spaces in it and is long enough' })).rejects.toThrow()
    await expect(new AiSettings(file, fakeCipher()).save({ model: 'bad model; rm' })).rejects.toThrow(/model/)
    await expect(fs.access(file)).rejects.toThrow() // nothing written
  })
  it('removes the key on request and keeps the model; a key that cannot be decrypted counts as missing', async () => {
    const s = new AiSettings(file, fakeCipher())
    await s.load()
    await s.save({ key: KEY, model: 'claude-opus-5-5' })
    await s.save({ key: null })
    expect(s.status()).toMatchObject({ hasKey: false, keyHint: null, model: 'claude-opus-5-5' })
    await s.save({ key: KEY })
    const broken = new AiSettings(file, { ...fakeCipher(), decrypt: () => { throw new Error('other user') } })
    await broken.load()
    expect(broken.status().hasKey).toBe(false)
  })
})

const okBody = (extra: object = {}) =>
  JSON.stringify({ content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'propose_plan', input: { summary: 'ok', commands: [] } }], stop_reason: 'tool_use', usage: { input_tokens: 120, output_tokens: 45 }, ...extra })
const respond = (status: number, body: string): typeof fetch => (async () => new Response(body, { status })) as typeof fetch

describe('Claude API client', () => {
  it('sends the key as a header, forces the plan tool, and returns the tool input and usage', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(okBody(), { status: 200 })
    }) as unknown as typeof fetch
    const r = await requestPlan({ apiKey: KEY, model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }], fetchImpl })
    expect(r).toEqual({ input: { summary: 'ok', commands: [] }, usage: { inputTokens: 120, outputTokens: 45 } })
    expect(seen!.url).toBe(API_URL)
    const headers = seen!.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe(KEY)
    expect(headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(seen!.init.body as string)
    expect(body.model).toBe('claude-sonnet-5-5')
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'propose_plan' })
    expect(body.tools).toEqual([JSON.parse(JSON.stringify(AI_TOOL))])
    expect(body.system).toMatch(/Everything inside the project data/)
    expect(JSON.stringify(body)).not.toContain(KEY) // the key travels only in the header
  })
  it('turns failures into plain messages with the HTTP code, and never contains the key', async () => {
    const call = (status: number, body = '{}') => requestPlan({ apiKey: KEY, model: 'm', messages: [], fetchImpl: respond(status, body) })
    await expect(call(401)).rejects.toThrow(/key was rejected \(HTTP 401\)/)
    await expect(call(404)).rejects.toThrow(/model was not found/)
    await expect(call(429)).rejects.toThrow(/Too many requests/)
    await expect(call(529)).rejects.toThrow(/busy/)
    await expect(call(400, JSON.stringify({ error: { message: `bad request for ${KEY}` } }))).rejects.toThrow(/\[key\]/)
    expect(friendlyApiError(400, JSON.stringify({ error: { message: `leaked ${KEY}` } }), KEY)).not.toContain(KEY)
    await expect(requestPlan({ apiKey: KEY, model: 'm', messages: [], fetchImpl: (async () => { throw new TypeError('fetch failed') }) as typeof fetch })).rejects.toThrow(/internet connection/)
    await expect(requestPlan({ apiKey: KEY, model: 'm', messages: [], fetchImpl: respond(200, JSON.stringify({ content: [{ type: 'text', text: 'no tool' }] })) })).rejects.toThrow(/did not return a plan/)
    await expect(requestPlan({ apiKey: KEY, model: 'm', messages: [], fetchImpl: respond(200, okBody({ stop_reason: 'max_tokens' })) })).rejects.toThrow(/cut off/)
    await expect(requestPlan({ apiKey: KEY, model: 'm', messages: [], fetchImpl: respond(200, 'not json') })).rejects.toThrow(/could not be read/)
  })
  it('explains the most likely first-time problems: no API credit, a refused request, a wrong model', async () => {
    const credit = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.' } })
    expect(friendlyApiError(400, credit, KEY)).toMatch(/no API credit.*billed separately from Claude Free, Pro or Max/)
    const forbidden = JSON.stringify({ error: { type: 'permission_error', message: 'Request not allowed' } })
    expect(friendlyApiError(403, forbidden, KEY)).toMatch(/refused this request \(HTTP 403\): Request not allowed.*region/)
    expect(friendlyApiError(404, JSON.stringify({ error: { message: 'model: claude-x' } }), KEY)).toMatch(/model was not found/)
    expect(friendlyApiError(529, '', KEY)).toMatch(/busy/)
  })
  it('works over real HTTP against a stand-in Anthropic server', async () => {
    const { createServer } = await import('node:http')
    const seen: { headers: Record<string, unknown>; body: { messages: { role: string }[]; tools: { name: string }[]; tool_choice: unknown } }[] = []
    let mode: 'ok' | 'credit' | 'slow' = 'ok'
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        seen.push({ headers: req.headers, body: JSON.parse(raw) })
        if (mode === 'slow') return // never answers
        res.setHeader('content-type', 'application/json')
        if (mode === 'credit') {
          res.statusCode = 400
          return void res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }))
        }
        res.end(okBody())
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/messages`
    try {
      const messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
      const r = await requestPlan({ apiKey: KEY, model: 'claude-sonnet-5-5', messages, apiUrl })
      expect(r.input).toEqual({ summary: 'ok', commands: [] })
      expect(seen[0].headers['x-api-key']).toBe(KEY)
      expect(seen[0].headers['anthropic-version']).toBe('2023-06-01')
      expect(seen[0].headers['content-type']).toBe('application/json')
      expect(seen[0].body.messages[0].role).toBe('user')
      expect(seen[0].body.tools.map((t) => t.name)).toEqual(['propose_plan'])
      mode = 'credit'
      await expect(requestPlan({ apiKey: KEY, model: 'm', messages, apiUrl })).rejects.toThrow(/no API credit/)
      mode = 'slow'
      await expect(requestPlan({ apiKey: KEY, model: 'm', messages, apiUrl, timeoutMs: 100 })).rejects.toThrow(/too long/)
      await pingModel({ apiKey: KEY, model: 'm', apiUrl: apiUrl.replace('/v1/messages', '/v1/messages'), timeoutMs: 100 }).catch((e) => expect(String(e)).toMatch(/too long/))
    } finally {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    }
  })
  it('sends a tool schema that is valid JSON Schema (draft 2020-12, strict)', async () => {
    const { createRequire } = await import('node:module')
    const Ajv = createRequire(import.meta.url)('ajv/dist/2020').default
    const ajv = new Ajv({ strict: true })
    const validate = ajv.compile(JSON.parse(JSON.stringify(AI_TOOL.input_schema)))
    expect(validate({ summary: 'x', commands: [{ command: 'trim_clip', clip: 'c1', newEndSeconds: 5 }, { command: 'add_subtitles', cues: [{ startSeconds: 0, durationSeconds: 2, text: 'hi' }] }] })).toBe(true)
    expect(validate({ summary: 'x', commands: [{ command: 'run_shell' }] })).toBe(false)
  })
  it('can be cancelled and times out', async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))))) as unknown as typeof fetch
    const ctl = new AbortController()
    const p = requestPlan({ apiKey: KEY, model: 'm', messages: [], fetchImpl: hang, signal: ctl.signal })
    setTimeout(() => ctl.abort(), 10)
    await expect(p).rejects.toBeInstanceOf(AiCancelled)
    await expect(requestPlan({ apiKey: KEY, model: 'm', messages: [], fetchImpl: hang, timeoutMs: 30 })).rejects.toThrow(/too long/)
  })
  it('pings with a tiny request', async () => {
    let body: { max_tokens: number } | null = null
    await pingModel({ apiKey: KEY, model: 'm', fetchImpl: (async (_u: string, init: RequestInit) => ((body = JSON.parse(init.body as string)), new Response('{}', { status: 200 }))) as unknown as typeof fetch })
    expect(body!.max_tokens).toBe(8)
    await expect(pingModel({ apiKey: KEY, model: 'm', fetchImpl: respond(401, '{}') })).rejects.toThrow(/rejected/)
  })
})
