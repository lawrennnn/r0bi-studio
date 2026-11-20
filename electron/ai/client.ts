import { AI_SYSTEM_PROMPT, AI_TOOL } from '../../shared/ai'

export const API_URL = 'https://api.anthropic.com/v1/messages'
export const API_VERSION = '2023-06-01'

export class AiCancelled extends Error {
  constructor() {
    super('Cancelled')
  }
}

export interface PlanCall {
  apiKey: string
  model: string
  messages: unknown[]
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** For tests: a local server standing in for Anthropic. */
  apiUrl?: string
}
export interface PlanReply {
  input: unknown
  usage: { inputTokens: number; outputTokens: number }
}

/** Turn an HTTP failure into something a person can act on. Never includes the key. */
export function friendlyApiError(status: number, body: string, apiKey: string): string {
  let detail = ''
  try {
    const m = (JSON.parse(body) as { error?: { message?: string } }).error?.message
    if (m) detail = m.split(apiKey).join('[key]').slice(0, 200)
  } catch {
    /* not JSON */
  }
  const code = `(HTTP ${status})`
  if (/credit balance/i.test(detail)) {
    return `Your Anthropic account has no API credit ${code}. API use is billed separately from Claude Free, Pro or Max chat plans. Add credit under Billing in the Anthropic Console, then try again`
  }
  if (status === 401) return `The API key was rejected ${code}. Check that it was copied completely, or make a new one in the Anthropic Console`
  if (status === 403) return `Anthropic refused this request ${code}${detail ? `: ${detail}` : ''}. The key may not have access to this model, or the API may not be available for your account or region`
  if (status === 404) return `That model was not found ${code}. Pick another model in Settings`
  if (status === 413) return `The project is too large to send ${code}. Try a smaller request`
  if (status === 429) return `Too many requests or the usage limit was reached ${code}. Wait a moment and try again`
  if (status === 400) return `The request was refused ${code}${detail ? `: ${detail}` : ''}`
  if (status >= 500) return `Anthropic is busy or having problems ${code}. Try again in a minute`
  return `The request failed ${code}${detail ? `: ${detail}` : ''}`
}

async function post(call: PlanCall, body: unknown): Promise<unknown> {
  const doFetch = call.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(call.timeoutMs ?? 90_000)
  const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout
  let res: Response
  try {
    res = await doFetch(call.apiUrl ?? API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': call.apiKey, 'anthropic-version': API_VERSION },
      body: JSON.stringify(body),
      signal
    })
  } catch (e) {
    if (call.signal?.aborted) throw new AiCancelled()
    if (timeout.aborted) throw new Error('The assistant took too long to answer. Try again')
    void e
    throw new Error('Could not reach Anthropic. Check your internet connection')
  }
  const text = await res.text()
  if (!res.ok) throw new Error(friendlyApiError(res.status, text, call.apiKey))
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Anthropic sent a reply that could not be read')
  }
}

/** Ask Claude for a plan. The model is forced to answer through the propose_plan tool. */
export async function requestPlan(call: PlanCall): Promise<PlanReply> {
  const json = (await post(call, {
    model: call.model,
    max_tokens: 4096,
    system: AI_SYSTEM_PROMPT,
    messages: call.messages,
    tools: [AI_TOOL],
    tool_choice: { type: 'tool', name: AI_TOOL.name }
  })) as { content?: { type: string; name?: string; input?: unknown }[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } }
  if (json.stop_reason === 'max_tokens') throw new Error('The assistant ran out of room and its plan was cut off. Try a smaller request')
  const block = json.content?.find((b) => b.type === 'tool_use' && b.name === AI_TOOL.name)
  if (!block) throw new Error('The assistant did not return a plan. Try again')
  return { input: block.input, usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 } }
}

/** A tiny request to check that the key and model work. */
export async function pingModel(call: Omit<PlanCall, 'messages'>): Promise<void> {
  await post({ ...call, messages: [] }, { model: call.model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with OK.' }] })
}
