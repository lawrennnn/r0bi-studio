import { AudioLines, Captions, ChevronLeft, ChevronRight, Clapperboard, Film, Image, LayoutTemplate, Sparkles, type LucideIcon } from 'lucide-react'
import { useUiStore, type LeftTab } from '../store/uiStore'
import { MediaPanel } from './MediaPanel'
import { SubtitlesPanel } from './SubtitlesPanel'
import { AutomationPanel } from './AutomationPanel'
import { EffectsPanel } from './EffectsPanel'
import { ScenesPanel } from './ScenesPanel'

const TABS: { id: LeftTab; label: string; icon: LucideIcon; note: string }[] = [
  { id: 'media', label: 'Media', icon: Film, note: '' },
  { id: 'scenes', label: 'Scenes', icon: Clapperboard, note: '' },
  { id: 'audio', label: 'Audio', icon: AudioLines, note: '' },
  { id: 'images', label: 'Images', icon: Image, note: '' },
  { id: 'subtitles', label: 'Subtitles', icon: Captions, note: '' },
  { id: 'effects', label: 'Effects', icon: Sparkles, note: '' },
  { id: 'templates', label: 'Automation', icon: LayoutTemplate, note: '' }
]

export function LeftSidebar({ hasProject }: { hasProject: boolean }) {
  const leftTab = useUiStore((s) => s.leftTab)
  const leftCollapsed = useUiStore((s) => s.leftCollapsed)
  const patch = useUiStore((s) => s.patch)
  const active = TABS.find((t) => t.id === leftTab) ?? TABS[0]

  return (
    <aside className="flex w-full min-w-0 bg-ink-800">
      <nav className="flex w-12 flex-col items-center gap-1 border-r border-ink-950 py-2" aria-label="Library sections">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            title={label}
            aria-label={label}
            aria-pressed={leftTab === id && !leftCollapsed}
            onClick={() => patch({ leftTab: id, leftCollapsed: leftTab === id ? !leftCollapsed : false })}
            className={`icon-btn h-9 w-9 ${leftTab === id && !leftCollapsed ? 'bg-accent-soft !text-accent' : ''}`}
          >
            <Icon size={18} />
          </button>
        ))}
        <button className="icon-btn mt-auto" title={leftCollapsed ? 'Expand panel' : 'Collapse panel'} onClick={() => patch({ leftCollapsed: !leftCollapsed })}>
          {leftCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </nav>
      {!leftCollapsed && (
        <div className="flex min-w-0 flex-1 flex-col p-3">
          {!hasProject ? (
            <div className="flex flex-1 items-center justify-center text-ink-300">Open or create a project to start.</div>
          ) : active.id === 'media' || active.id === 'audio' || active.id === 'images' ? (
            <MediaPanel key={active.id} title={active.label} filter={active.id === 'media' ? null : active.id === 'audio' ? 'audio' : 'image'} />
          ) : active.id === 'subtitles' ? (
            <SubtitlesPanel />
          ) : active.id === 'templates' ? (
            <AutomationPanel />
          ) : active.id === 'effects' ? (
            <EffectsPanel />
          ) : active.id === 'scenes' ? (
            <ScenesPanel />
          ) : (
            <>
              <h2 className="panel-title mb-3">{active.label}</h2>
              <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-ink-600 p-4 text-center text-ink-300">
                {active.note}
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  )
}
