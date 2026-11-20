import type { CSSProperties } from 'react'
import type { SubtitleStyle } from '@shared/project'

/** Fonts offered in the style panel. Any installed font name can also be typed. */
export const FONT_SUGGESTIONS = ['Segoe UI', 'Arial', 'Tahoma', 'Verdana', 'Georgia', 'Impact', 'Consolas', 'Khmer UI', 'Leelawadee UI', 'Noto Sans Khmer', 'Battambang', 'Hanuman']

/** Khmer-capable fallbacks, so Khmer text shows even when the chosen font has no Khmer glyphs. */
export function fontStack(family: string): string {
  const clean = family.replace(/["'\\]/g, '').trim() || 'Segoe UI'
  return `"${clean}", "Khmer UI", "Leelawadee UI", "Noto Sans Khmer", sans-serif`
}

export function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** Positioning and text look for the block. `scale` converts project pixels to preview pixels. */
export function subtitleBlockCss(style: SubtitleStyle, scale: number): CSSProperties {
  return {
    position: 'absolute',
    left: '4%',
    right: '4%',
    top: `${style.positionY}%`,
    transform: 'translateY(-50%)',
    textAlign: 'center',
    fontFamily: fontStack(style.fontFamily),
    fontSize: style.fontSize * scale,
    fontWeight: style.bold ? 700 : 400,
    lineHeight: 1.25,
    color: style.color,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    // The stroke is centred on the glyph edge, so double it and paint it under the fill.
    ...(style.outlineWidth > 0 ? { WebkitTextStroke: `${style.outlineWidth * scale * 2}px ${style.outlineColor}`, paintOrder: 'stroke fill' as const } : {}),
    pointerEvents: 'none'
  }
}

export function subtitleBoxCss(style: SubtitleStyle, scale: number): CSSProperties {
  return {
    background: style.bgOpacity > 0 ? hexToRgba(style.bgColor, style.bgOpacity / 100) : 'transparent',
    padding: `${0.1 * style.fontSize * scale}px ${0.4 * style.fontSize * scale}px`,
    borderRadius: 0.15 * style.fontSize * scale,
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone'
  }
}
