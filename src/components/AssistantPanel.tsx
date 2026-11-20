import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, MinusCircle, Send, Settings as SettingsIcon, Sparkles, Square, Trash2, XCircle } from 'lucide-react'
import { useAiStore, type AiMessage } from '../store/aiStore'
import { applyPlan, askAssistant, askToFix, discardPlan, stopAssistant, testAssistant } from '../lib/aiActions'
import { Empty } from './fields'

const IDEAS = [
  'Make this video more exciting',
  'Synchronize the narration with the scenes',
  'Add subtitles from my script',
  'Shorten the introduction',
  'Increase the music slightly',
  'Make the transitions smoother'
]

function PlanCard({ m }: { m: AiMessage }) {
  const p = m.plan
  if (!p) return null
  const { exec } = p
  return (
    <div className="mt-2 rounded-md border border-ink-600 bg-ink-900 p-2">
      {p.plan.commands.length === 0 ? (
        <p className="text-ink-300">No changes proposed.</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {exec.steps.map((s) => (
            <li key={s.index} className="flex items-start gap-1.5">
              {s.status === 'ok' ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-400" /> : s.status === 'failed' ? <XCircle size={14} className="mt-0.5 shrink-0 text-red-400" /> : <MinusCircle size={14} className="mt-0.5 shrink-0 text-ink-500" />}
              <span className={s.status === 'failed' ? 'text-red-300' : s.status === 'skipped' ? 'text-ink-300' : ''}>{s.text}</span>
            </li>
          ))}
        </ol>
      )}
      {(p.plan.notes ?? []).map((n, i) => <p key={i} className="mt-2 text-amber-200">{n}</p>)}
      {(p.plan.questions ?? []).map((q, i) => <p key={i} className="mt-2 font-medium">{q}</p>)}

      {p.plan.commands.length > 0 && p.status === 'pending' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {exec.ok ? (
            <>
              <button className="btn btn-primary h-7 px-3 text-xs" onClick={() => applyPlan(m.id)}>Apply plan</button>
              <button className="btn h-7 px-3 text-xs" onClick={() => discardPlan(m.id)}>Discard</button>
              <span className="text-ink-300">One undo step (Ctrl+Z).</span>
            </>
          ) : (
            <>
              <button className="btn h-7 px-3 text-xs" onClick={() => askToFix(m.id)}>Ask the assistant to fix it</button>
              <button className="btn h-7 px-3 text-xs" onClick={() => discardPlan(m.id)}>Discard</button>
              <span className="text-red-300">Nothing will be changed.</span>
            </>
          )}
        </div>
      )}
      {p.status === 'applied' && <p className="mt-2 text-emerald-300">Applied. Press Ctrl+Z to undo all of it.</p>}
      {p.status === 'discarded' && <p className="mt-2 text-ink-300">Discarded.</p>}
      {p.usage && <p className="mt-1 text-[11px] text-ink-500">{p.usage.inputTokens + p.usage.outputTokens} tokens · {p.model}</p>}
    </div>
  )
}

export function AssistantPanel() {
  const { messages, busy, status, includeThumbnails } = useAiStore()
  const patch = useAiStore((s) => s.patch)
  const [text, setText] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, busy])

  if (!status) return <Empty>Loading…</Empty>
  if (!status.hasKey) {
    return (
      <div className="flex flex-col gap-3">
        <Empty>
          The AI assistant is optional. It turns requests like "shorten the introduction" into a plan you review and approve. Everything else in the editor works without it.
        </Empty>
        <button className="btn btn-primary justify-center" onClick={() => patch({ settingsOpen: true })}><SettingsIcon size={14} />Add an Anthropic API key</button>
      </div>
    )
  }

  const send = () => {
    const t = text.trim()
    if (!t || busy) return
    setText('')
    void askAssistant(t)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center">
        <h2 className="panel-title flex-1">Assistant</h2>
        <button className="btn h-6 px-2 text-xs" title="Check that the key, model and internet connection work" disabled={busy} onClick={() => void testAssistant()}>Test connection</button>
        <button className="icon-btn icon-btn-sm ml-1" title="Settings" onClick={() => patch({ settingsOpen: true })}><SettingsIcon size={13} /></button>
        <button className="icon-btn icon-btn-sm" title="Clear chat" disabled={messages.length === 0 || busy} onClick={() => useAiStore.getState().reset()}><Trash2 size={13} /></button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pr-1">
        {messages.length === 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-ink-300">Describe what you want. You always see the plan first and nothing changes until you press Apply.</p>
            {IDEAS.map((idea) => (
              <button key={idea} className="btn h-auto justify-start whitespace-normal py-1.5 text-left" disabled={busy} onClick={() => void askAssistant(idea)}><Sparkles size={13} className="shrink-0 text-accent" />{idea}</button>
            ))}
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((m) => (
              <li key={m.id} className={m.role === 'user' ? 'ml-6 rounded-md bg-accent-soft p-2' : m.role === 'error' ? 'rounded-md border border-red-900 bg-red-950/60 p-2 text-red-200' : 'rounded-md bg-ink-700 p-2'}>
                <p className="whitespace-pre-wrap break-words">{m.text}</p>
                {m.role === 'error' && <button className="btn mt-2 h-6 px-2 text-xs" onClick={() => patch({ settingsOpen: true })}>Open Settings</button>}
                <PlanCard m={m} />
              </li>
            ))}
            {busy && (
              <li className="flex items-center gap-2 text-ink-300"><Loader2 size={14} className="animate-spin" />Thinking…</li>
            )}
            <div ref={endRef} />
          </ul>
        )}
      </div>

      <label className="flex items-start gap-2 text-ink-300">
        <input type="checkbox" className="mt-0.5 accent-[#2f7bff]" checked={includeThumbnails} onChange={(e) => patch({ includeThumbnails: e.target.checked })} />
        <span>Also send small thumbnails of my media (they leave this computer)</span>
      </label>
      <div className="flex items-end gap-1">
        <textarea
          className="field h-16 resize-none py-1"
          placeholder="What should I change?"
          value={text}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
        />
        {busy ? (
          <button className="btn h-8 px-2" title="Stop" onClick={() => void stopAssistant()}><Square size={14} /></button>
        ) : (
          <button className="btn btn-primary h-8 px-2" title="Send (Enter)" disabled={!text.trim()} onClick={send}><Send size={14} /></button>
        )}
      </div>
    </div>
  )
}
