import { clamp } from '../store/uiStore'

interface Props {
  axis: 'x' | 'y'
  size: number
  min: number
  max: number
  /** Dragging toward the start of the axis grows the panel (right sidebar, bottom timeline). */
  invert?: boolean
  onChange(size: number): void
  label: string
}

export function Resizer({ axis, size, min, max, invert, onChange, label }: Props) {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const start = axis === 'x' ? e.clientX : e.clientY
    const startSize = size
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
    const move = (ev: PointerEvent) => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - start
      onChange(clamp(startSize + (invert ? -delta : delta), min, max))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const keys = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
    if (!keys.includes(e.key)) return
    e.preventDefault()
    const dir = e.key === keys[1] ? 1 : -1
    onChange(clamp(size + (invert ? -dir : dir) * 16, min, max))
  }

  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={
        axis === 'x'
          ? 'w-1 shrink-0 cursor-col-resize bg-ink-950 transition-colors hover:bg-accent focus-visible:bg-accent'
          : 'h-1 shrink-0 cursor-row-resize bg-ink-950 transition-colors hover:bg-accent focus-visible:bg-accent'
      }
    />
  )
}
