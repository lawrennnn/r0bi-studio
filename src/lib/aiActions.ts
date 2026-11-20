import { buildContext, executePlan, parseAiPlan, type ChatTurn, type ThumbnailInput } from '@shared/ai'
import { useProjectStore } from '../store/projectStore'
import { useUiStore } from '../store/uiStore'
import { useMediaStore } from '../store/mediaStore'
import { useExportStore } from '../store/exportStore'
import { useAiStore } from '../store/aiStore'

const ai = () => useAiStore.getState()
const NO_BRIDGE = 'The assistant needs the desktop app. Start it with "npm run dev".'
const MAX_THUMBNAILS = 8
const MAX_THUMB_CHARS = 120_000

export async function loadAiStatus(): Promise<void> {
  const res = await window.r0bi?.ai.getSettings()
  if (res?.ok) ai().patch({ status: res.data })
}

/** Small images of media used on the timeline, only when the user turned this on for the request. */
function collectThumbnails(aliasOf: (assetId: string) => string | undefined): ThumbnailInput[] {
  const project = useProjectStore.getState().project
  if (!project) return []
  const thumbs = useMediaStore.getState().thumbs
  const used = [...new Set(project.clips.map((c) => c.assetId))]
  const out: ThumbnailInput[] = []
  for (const id of used) {
    const asset = project.media.find((a) => a.id === id)
    const url = thumbs[id]
    const alias = aliasOf(id)
    const m = url ? /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(url) : null
    if (!asset || asset.kind === 'audio' || !alias || !m || m[2].length > MAX_THUMB_CHARS) continue
    out.push({ alias, mediaType: m[1] as ThumbnailInput['mediaType'], data: m[2] })
    if (out.length >= MAX_THUMBNAILS) break
  }
  return out
}

function historyOf(): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (const m of ai().messages) {
    if (m.role === 'user') turns.push({ role: 'user', text: m.text })
    else if (m.role === 'assistant') {
      const extra = [...(m.plan?.plan.questions ?? []), ...(m.plan?.plan.notes ?? [])].join(' ')
      const state = m.plan ? ` [${m.plan.status === 'applied' ? 'applied' : m.plan.status === 'discarded' ? 'discarded' : 'not applied'}, ${m.plan.plan.commands.length} commands]` : ''
      turns.push({ role: 'assistant', text: `${m.text}${state}${extra ? ` ${extra}` : ''}` })
    }
  }
  return turns
}

/** Ask the assistant for a plan. The plan is checked and dry-run here; nothing changes until the user applies it. */
export async function askAssistant(request: string): Promise<void> {
  const api = window.r0bi
  const project = useProjectStore.getState().project
  const text = request.trim()
  if (!text || ai().busy) return
  if (!api) return void ai().push({ role: 'error', text: NO_BRIDGE })
  if (!project) return
  if (!ai().status?.hasKey) return void ai().push({ role: 'error', text: 'Add your Anthropic API key in Settings to use the assistant.' })

  const history = historyOf()
  ai().push({ role: 'user', text })
  ai().patch({ busy: true })
  try {
    const ui = useUiStore.getState()
    const { context, aliases } = buildContext(project, {
      playheadFrame: ui.playhead,
      selectedClipId: ui.selectedClipId,
      selectedCueId: ui.selectedCueId,
      exportSettings: useExportStore.getState().settings
    })
    const thumbnails = ai().includeThumbnails ? collectThumbnails((id) => aliases.alias(id)) : []
    const res = await api.ai.plan({ request: text, history, context, thumbnails })
    if (!res.ok) return void ai().push({ role: 'error', text: res.cancelled ? 'Cancelled.' : res.error })

    const parsed = parseAiPlan(res.data.plan)
    if (!parsed.ok) return void ai().push({ role: 'error', text: `${parsed.error}. Nothing was changed. Try asking again.` })
    const exec = executePlan(project, parsed.plan, aliases)
    ai().push({
      role: 'assistant',
      text: parsed.plan.summary,
      plan: { plan: parsed.plan, exec, aliases, status: 'pending', usage: res.data.usage, model: res.data.model }
    })
  } catch (e) {
    ai().push({ role: 'error', text: e instanceof Error ? e.message : 'Something went wrong' })
  } finally {
    ai().patch({ busy: false })
  }
}

export async function stopAssistant(): Promise<void> {
  await window.r0bi?.ai.cancel()
}

/**
 * Apply a reviewed plan as ONE undo step. The plan is checked again against the project as it is
 * now, so edits made while the plan was on screen cannot make it break a timeline rule.
 */
export function applyPlan(messageId: string): boolean {
  const msg = ai().messages.find((m) => m.id === messageId)
  const project = useProjectStore.getState().project
  if (!msg?.plan || msg.plan.status !== 'pending' || !project) return false
  const exec = executePlan(project, msg.plan.plan, msg.plan.aliases)
  if (!exec.ok) {
    ai().update(messageId, (m) => (m.plan ? { ...m, plan: { ...m.plan, exec } } : m))
    ai().push({ role: 'error', text: `The plan can no longer be applied: ${exec.error}. Nothing was changed.` })
    return false
  }
  if (exec.steps.some((s) => s.command !== 'set_export_settings')) {
    useProjectStore.getState().commit((d) => {
      d.tracks = exec.project.tracks
      d.clips = exec.project.clips
      d.subtitles = exec.project.subtitles
    })
  }
  if (Object.keys(exec.exportPatch).length > 0) useExportStore.getState().set(exec.exportPatch)
  useUiStore.getState().patch({ selectedClipId: null, selectedCueId: null })
  ai().update(messageId, (m) => (m.plan ? { ...m, plan: { ...m.plan, exec, status: 'applied' } } : m))
  return true
}

export function discardPlan(messageId: string): void {
  ai().update(messageId, (m) => (m.plan && m.plan.status === 'pending' ? { ...m, plan: { ...m.plan, status: 'discarded' } } : m))
}

/** Send the failure back to the assistant so it can propose a corrected plan. */
export function askToFix(messageId: string): void {
  const msg = ai().messages.find((m) => m.id === messageId)
  if (!msg?.plan?.exec.error) return
  void askAssistant(`That plan could not be applied: ${msg.plan.exec.error}. Please propose a corrected plan.`)
}

/** Check the key, model and network, and report the result in the chat. */
export async function testAssistant(): Promise<void> {
  const api = window.r0bi
  if (!api) return void ai().push({ role: 'error', text: NO_BRIDGE })
  ai().patch({ busy: true })
  try {
    const res = await api.ai.test()
    ai().push(res.ok ? { role: 'assistant', text: `Connected. ${res.data.model} answered, so the key, model and internet connection all work.` } : { role: 'error', text: res.error })
  } catch (e) {
    ai().push({ role: 'error', text: e instanceof Error ? e.message : 'Something went wrong' })
  } finally {
    ai().patch({ busy: false })
  }
}
