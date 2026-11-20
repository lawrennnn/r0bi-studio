import { AudioLines, Film, Image as ImageIcon, Link2, ListPlus, Loader2, Plus, Trash2, TriangleAlert, X, Zap, type LucideIcon } from 'lucide-react'
import type { MediaAsset, MediaKind } from '@shared/project'
import { useProjectStore } from '../store/projectStore'
import { useMediaStore } from '../store/mediaStore'
import { useUiStore } from '../store/uiStore'
import { timeline } from '../store/timelineActions'
import { cancelProxy, importDropped, importWithDialog, makeProxy, relinkAsset, removeAsset } from '../lib/mediaActions'
import { formatBytes, formatDuration, formatFps } from '../lib/format'

const KIND_ICON: Record<MediaKind, LucideIcon> = { video: Film, audio: AudioLines, image: ImageIcon }

function Card({ asset }: { asset: MediaAsset }) {
  const thumb = useMediaStore((s) => s.thumbs[asset.id])
  const missing = useMediaStore((s) => s.missing[asset.id])
  const busy = useMediaStore((s) => s.busy[asset.id])
  const selected = useMediaStore((s) => s.selected === asset.id)
  const patch = useMediaStore((s) => s.patch)
  const Icon = KIND_ICON[asset.kind]
  const addToTimeline = () => {
    if (!timeline.addAssetAuto(asset.id)) patch({ notice: `No unlocked ${asset.kind === 'audio' ? 'audio' : 'video or overlay'} track is available. Add or unlock one.` })
  }

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-r0bi-asset', asset.id)
        e.dataTransfer.effectAllowed = 'copy'
        useUiStore.getState().patch({ dragAsset: { id: asset.id, kind: asset.kind } })
      }}
      onDragEnd={() => useUiStore.getState().patch({ dragAsset: null })}
      onDoubleClick={addToTimeline}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => patch({ selected: asset.id })}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), patch({ selected: asset.id }))}
      className={`group relative flex flex-col overflow-hidden rounded-md border bg-ink-900 ${selected ? 'border-accent' : 'border-ink-600 hover:border-ink-500'}`}
    >
      <div className="relative flex aspect-video items-center justify-center bg-black">
        {thumb ? <img src={thumb} alt="" className={`h-full w-full object-cover ${missing ? 'opacity-30' : ''}`} draggable={false} /> : <Icon size={22} className="text-ink-500" />}
        {asset.kind !== 'image' && asset.durationMs > 0 && (
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] tabular-nums">{formatDuration(asset.durationMs)}</span>
        )}
        <div className="absolute left-1 top-1 flex gap-1">
          {missing && <span className="flex items-center gap-1 rounded bg-red-600 px-1 text-[10px] font-medium"><TriangleAlert size={10} />Missing</span>}
          {asset.proxy && <span className="rounded bg-accent px-1 text-[10px] font-medium">Proxy</span>}
        </div>
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center gap-1 bg-black/60 text-xs">
            <Loader2 size={14} className="animate-spin" />{busy === 'proxy' ? 'Making proxy…' : 'Relinking…'}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 px-2 py-1">
        <span className="min-w-0 flex-1 truncate" title={asset.name}>{asset.name}</span>
      </div>
      <div className="absolute right-1 top-1 hidden gap-1 group-hover:flex group-focus-within:flex">
        {!busy && <button className="icon-btn icon-btn-sm bg-black/70" title="Add to timeline at the playhead (or drag it onto a track)" onClick={(e) => { e.stopPropagation(); addToTimeline() }}><ListPlus size={13} /></button>}
        {missing && !busy && <button className="icon-btn icon-btn-sm bg-black/70" title="Locate file…" onClick={(e) => { e.stopPropagation(); void relinkAsset(asset) }}><Link2 size={13} /></button>}
        {asset.kind === 'video' && !missing && (busy === 'proxy'
          ? <button className="icon-btn icon-btn-sm bg-black/70" title="Cancel proxy" onClick={(e) => { e.stopPropagation(); void cancelProxy(asset.id) }}><X size={13} /></button>
          : !busy && <button className="icon-btn icon-btn-sm bg-black/70" title={asset.proxy ? 'Rebuild 540p proxy' : 'Make 540p proxy for smooth editing'} onClick={(e) => { e.stopPropagation(); void makeProxy(asset) }}><Zap size={13} /></button>)}
        {!busy && <button className="icon-btn icon-btn-sm bg-black/70" title="Remove from project (file is not deleted)" onClick={(e) => { e.stopPropagation(); removeAsset(asset.id) }}><Trash2 size={13} /></button>}
      </div>
    </div>
  )
}

function Details({ asset }: { asset: MediaAsset }) {
  const rows: [string, string][] = [
    ['Type', asset.kind],
    ...(asset.kind !== 'audio' ? ([['Size', `${asset.width} × ${asset.height}`]] as [string, string][]) : []),
    ...(asset.kind === 'video' ? ([['Frame rate', formatFps(asset.fpsNum, asset.fpsDen)]] as [string, string][]) : []),
    ...(asset.kind !== 'image' ? ([['Duration', formatDuration(asset.durationMs)]] as [string, string][]) : []),
    ...(asset.videoCodec ? ([['Video codec', asset.videoCodec]] as [string, string][]) : []),
    ...(asset.audioCodec ? ([['Audio', `${asset.audioCodec}, ${asset.sampleRate} Hz, ${asset.channels} ch`]] as [string, string][]) : []),
    ['File size', formatBytes(asset.sizeBytes)],
    ['Location', asset.path]
  ]
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-t border-ink-600 pt-2 text-[12px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-300">{k}</dt>
          <dd className="min-w-0 break-all text-ink-100">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function MediaPanel({ filter, title }: { filter: MediaKind | null; title: string }) {
  const all = useProjectStore((s) => s.project?.media ?? [])
  const { importing, dragging, notice, tools, selected, patch } = useMediaStore()
  const items = filter ? all.filter((a) => a.kind === filter) : all
  const sel = all.find((a) => a.id === selected)
  const toolsMissing = tools && (!tools.ffmpeg.found || !tools.ffprobe.found)

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col gap-2"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); if (!dragging) patch({ dragging: true }) } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) patch({ dragging: false }) }}
      onDrop={(e) => { e.preventDefault(); patch({ dragging: false }); void importDropped(Array.from(e.dataTransfer.files)) }}
    >
      <div className="flex items-center">
        <h2 className="panel-title flex-1">{title}</h2>
        <button className="btn h-7 px-2 text-xs" disabled={importing || !!toolsMissing} onClick={() => void importWithDialog()}>
          {importing ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}Import
        </button>
      </div>

      {toolsMissing && (
        <div role="alert" className="rounded-md border border-amber-700 bg-amber-950/50 p-2 text-amber-200">
          FFmpeg was not found. Run <code>npm install</code> again, or install FFmpeg (for example <code>winget install Gyan.FFmpeg</code>) and restart the app.
        </div>
      )}
      {notice && (
        <div role="status" className="flex items-start gap-2 rounded-md bg-ink-700 p-2 text-ink-200">
          <span className="flex-1">{notice}</span>
          <button className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={() => patch({ notice: null })}><X size={12} /></button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {items.length === 0 ? (
          <div className="flex h-full min-h-32 items-center justify-center rounded-md border border-dashed border-ink-600 p-4 text-center text-ink-300">
            Drop files here or click Import.<br />MP4, MOV, MKV, PNG, JPG, WAV, MP3, AAC
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2">
            {items.map((a) => <Card key={a.id} asset={a} />)}
          </div>
        )}
      </div>
      {sel && (!filter || sel.kind === filter) && <Details asset={sel} />}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md border-2 border-dashed border-accent bg-accent-soft font-medium">
          Drop to import
        </div>
      )}
    </div>
  )
}
