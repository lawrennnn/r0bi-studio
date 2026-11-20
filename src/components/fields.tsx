import type { ReactNode } from 'react'

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed border-ink-600 p-4 text-center text-ink-300">{children}</div>
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-ink-600 pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300">{title}</h3>
      {children}
    </section>
  )
}

/** Whole-number field that commits on blur/Enter. `onCommit` returns false to reject (the field reverts). */
export function NumField({ label, value, hint, disabled, min = 0, max, onCommit }: { label: string; value: number; hint?: string; disabled?: boolean; min?: number; max?: number; onCommit(n: number): boolean }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex justify-between text-ink-300"><span>{label}</span><span className="tabular-nums">{hint}</span></span>
      <input
        key={value}
        type="number"
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        defaultValue={value}
        className="field disabled:opacity-50"
        onBlur={(e) => {
          const n = Number(e.currentTarget.value)
          if (!Number.isFinite(n) || n === value || !onCommit(Math.round(n))) e.currentTarget.value = String(value)
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </label>
  )
}

export function Slider({ label, value, min = 0, max = 100, unit = '%', disabled, onChange }: { label: string; value: number; min?: number; max?: number; unit?: string; disabled?: boolean; onChange(n: number): void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex justify-between text-ink-300"><span>{label}</span><span className="tabular-nums text-ink-100">{value}{unit}</span></span>
      <input type="range" min={min} max={max} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[#2f7bff] disabled:opacity-40" />
    </label>
  )
}

export function NudgeRow({ disabled, onNudge, onStartAtPlayhead, fps }: { disabled?: boolean; fps: number; onNudge(frames: number): void; onStartAtPlayhead(): void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-ink-300">Move (sync)</span>
      <div className="flex flex-wrap gap-1">
        {[[-fps, '−1 s'], [-1, '−1 f'], [1, '+1 f'], [fps, '+1 s']].map(([d, label]) => (
          <button key={label} className="btn h-7 px-2 text-xs" disabled={disabled} onClick={() => onNudge(d as number)}>{label}</button>
        ))}
        <button className="btn h-7 px-2 text-xs" disabled={disabled} onClick={onStartAtPlayhead} title="Move the start to the playhead">Start at playhead</button>
      </div>
    </div>
  )
}
