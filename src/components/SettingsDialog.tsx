import { useEffect, useState } from 'react'
import { CheckCircle2, KeyRound, X, XCircle } from 'lucide-react'
import { AI_MODEL_CHOICES } from '@shared/ai'
import { useAiStore } from '../store/aiStore'
import { loadAiStatus } from '../lib/aiActions'

export function SettingsDialog() {
  const open = useAiStore((s) => s.settingsOpen)
  const status = useAiStore((s) => s.status)
  const patch = useAiStore((s) => s.patch)
  const [key, setKey] = useState('')
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    if (!open) return
    setKey('')
    setMsg(null)
    void loadAiStatus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && patch({ settingsOpen: false })
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, patch])

  if (!open) return null
  const api = window.r0bi
  const known = AI_MODEL_CHOICES.some((m) => m.id === status?.model)

  const run = async (fn: () => Promise<{ ok: boolean; text: string }>) => {
    setBusy(true)
    try {
      setMsg(await fn())
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Something went wrong' })
    } finally {
      setBusy(false)
    }
  }

  const save = (change: { model?: string; key?: string | null }, ok: string) =>
    run(async () => {
      const res = await api?.ai.saveSettings(change)
      if (!res) return { ok: false, text: 'Settings need the desktop app' }
      if (!res.ok) return { ok: false, text: res.error }
      patch({ status: res.data })
      setKey('')
      return { ok: true, text: ok }
    })

  const test = () =>
    run(async () => {
      const res = await api?.ai.test()
      if (!res) return { ok: false, text: 'Settings need the desktop app' }
      return res.ok ? { ok: true, text: `Connected. ${res.data.model} answered.` } : { ok: false, text: res.error }
    })

  return (
    <div className="fixed inset-0 z-[2100] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(e) => e.target === e.currentTarget && patch({ settingsOpen: false })}>
      <div className="flex max-h-[90vh] w-[560px] max-w-full flex-col overflow-hidden rounded-lg border border-ink-600 bg-ink-800 shadow-2xl">
        <div className="flex items-center border-b border-ink-950 px-4 py-3">
          <h2 className="flex-1 text-base font-semibold">Settings</h2>
          <button className="icon-btn" aria-label="Close" onClick={() => patch({ settingsOpen: false })}><X size={16} /></button>
        </div>

        <div className="flex flex-col gap-4 overflow-auto p-4">
          <section className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300">Claude assistant (optional)</h3>
            {!status ? (
              <p className="text-ink-300">Loading…</p>
            ) : (
              <>
                {!status.encryptionAvailable && (
                  <div role="alert" className="rounded-md border border-amber-700 bg-amber-950/50 p-2 text-amber-200">
                    This computer cannot encrypt secrets for the app, so an API key cannot be saved safely. The rest of the editor is not affected.
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <KeyRound size={15} className="text-ink-300" />
                  {status.hasKey ? <span>Key saved: <span className="font-mono">{status.keyHint}</span></span> : <span className="text-ink-300">No API key saved</span>}
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-ink-300">{status.hasKey ? 'Replace the key' : 'Anthropic API key'}</span>
                  <input type="password" autoComplete="off" spellCheck={false} className="field font-mono" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button className="btn btn-primary" disabled={busy || !key.trim() || !status.encryptionAvailable} onClick={() => void save({ key }, 'Key saved and encrypted on this computer.')}>Save key</button>
                  <button className="btn" disabled={busy || !status.hasKey} onClick={test}>Test connection</button>
                  <button className="btn" disabled={busy || !status.hasKey} onClick={() => window.confirm('Remove the saved API key from this computer?') && void save({ key: null }, 'Key removed.')}>Remove key</button>
                </div>

                <label className="flex flex-col gap-1">
                  <span className="text-ink-300">Model</span>
                  <select
                    className="field"
                    value={known ? status.model : 'custom'}
                    onChange={(e) => (e.target.value === 'custom' ? setCustom(status.model) : void save({ model: e.target.value }, 'Model changed.'))}
                  >
                    {AI_MODEL_CHOICES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    <option value="custom">Other (type a model name)…</option>
                  </select>
                </label>
                {(!known || custom) && (
                  <div className="flex gap-2">
                    <input className="field font-mono" aria-label="Custom model name" value={custom || status.model} onChange={(e) => setCustom(e.target.value)} />
                    <button className="btn" disabled={busy || !custom.trim()} onClick={() => void save({ model: custom.trim() }, 'Model changed.')}>Use</button>
                  </div>
                )}
                {msg && (
                  <div role="status" className={`flex items-start gap-2 rounded-md p-2 ${msg.ok ? 'bg-emerald-950/50 text-emerald-200' : 'bg-red-950/60 text-red-200'}`}>
                    {msg.ok ? <CheckCircle2 size={15} className="mt-0.5 shrink-0" /> : <XCircle size={15} className="mt-0.5 shrink-0" />}{msg.text}
                  </div>
                )}
              </>
            )}
          </section>

          <section className="flex flex-col gap-2 border-t border-ink-600 pt-3 text-ink-300">
            <h3 className="text-xs font-semibold uppercase tracking-wide">Privacy</h3>
            <ul className="list-disc space-y-1 pl-5">
              <li>Nothing is sent unless you press Send in the Assistant tab.</li>
              <li>Each request sends what you typed, your recent chat, and project facts: track, clip and subtitle names, times and levels. File paths and media files are never sent.</li>
              <li>Thumbnails are sent only when you tick the box in the Assistant tab.</li>
              <li>Your key is encrypted with Windows and kept in the app's private folder. It is not stored in projects and is never shown again.</li>
              <li>The assistant can only propose edits. You review every plan, and applying it is one undo step.</li>
              <li>Usage is billed to your Anthropic account. API use is separate from Claude Free, Pro or Max chat plans: you need API credit (Billing in the Anthropic Console) for the assistant to answer.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
