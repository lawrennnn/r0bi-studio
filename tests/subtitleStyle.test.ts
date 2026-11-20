import { describe, expect, it } from 'vitest'
import { DEFAULT_SUBTITLE_STYLE } from '../shared/project'
import { fontStack, hexToRgba, subtitleBlockCss, subtitleBoxCss } from '../src/lib/subtitleStyle'

describe('subtitle styling', () => {
  it('always adds Khmer-capable fallback fonts and strips quote characters', () => {
    expect(fontStack('Segoe UI')).toBe('"Segoe UI", "Khmer UI", "Leelawadee UI", "Noto Sans Khmer", sans-serif')
    expect(fontStack('Bad"; color: red')).toBe('"Bad; color: red", "Khmer UI", "Leelawadee UI", "Noto Sans Khmer", sans-serif')
    expect(fontStack('   ')).toContain('"Segoe UI"')
  })
  it('converts hex colours to rgba', () => {
    expect(hexToRgba('#ff8000', 0.5)).toBe('rgba(255, 128, 0, 0.5)')
  })
  it('scales sizes to the preview and places the block by vertical position', () => {
    const css = subtitleBlockCss({ ...DEFAULT_SUBTITLE_STYLE, fontSize: 60, positionY: 80, bold: true, outlineWidth: 4 }, 0.5)
    expect(css.fontSize).toBe(30)
    expect(css.top).toBe('80%')
    expect(css.fontWeight).toBe(700)
    expect(css.WebkitTextStroke).toBe(`4px ${DEFAULT_SUBTITLE_STYLE.outlineColor}`)
  })
  it('omits the outline when it is zero and the box when opacity is zero', () => {
    expect(subtitleBlockCss({ ...DEFAULT_SUBTITLE_STYLE, outlineWidth: 0 }, 1).WebkitTextStroke).toBeUndefined()
    expect(subtitleBoxCss({ ...DEFAULT_SUBTITLE_STYLE, bgOpacity: 0 }, 1).background).toBe('transparent')
    expect(subtitleBoxCss({ ...DEFAULT_SUBTITLE_STYLE, bgOpacity: 60, bgColor: '#000000' }, 1).background).toBe('rgba(0, 0, 0, 0.6)')
  })
})
