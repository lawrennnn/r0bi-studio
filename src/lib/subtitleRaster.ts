import type { SubtitleStyle } from '@shared/project'
import { fontStack } from './subtitleStyle'

/** Break text into lines that fit `maxWidth`, using word boundaries (Khmer has no spaces, so this uses ICU word segmentation). */
export function breakLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const seg =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? (s: string) => [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(s)].map((x) => x.segment)
      : (s: string) => s.split(/(\s+)/).filter(Boolean)
  const grapheme =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? (s: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map((x) => x.segment)
      : (s: string) => [...s]

  const out: string[] = []
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = ''
    const push = () => {
      out.push(line.trimEnd())
      line = ''
    }
    for (const piece of seg(paragraph)) {
      if (measure(line + piece) <= maxWidth || line === '') {
        if (measure(piece) > maxWidth && line === '') {
          // One unbreakable run that is too wide: split it by characters.
          for (const g of grapheme(piece)) {
            if (measure(line + g) > maxWidth && line !== '') push()
            line += g
          }
        } else line += piece
      } else {
        push()
        line = piece.trimStart()
      }
    }
    push()
  }
  return out
}

/**
 * Draws one subtitle on a transparent full-frame canvas, matching the preview's look:
 * centred block, per-line background boxes, outline painted under the fill.
 */
export function drawSubtitle(canvas: HTMLCanvasElement, text: string, style: SubtitleStyle, scale: number): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not draw subtitles')
  const W = canvas.width
  const H = canvas.height
  ctx.clearRect(0, 0, W, H)
  if (!text.trim()) return

  const px = style.fontSize * scale
  ctx.font = `${style.bold ? '700 ' : '400 '}${px}px ${fontStack(style.fontFamily)}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2

  const padX = 0.4 * px
  const lines = breakLines(text, W * 0.92 - 2 * padX, (s) => ctx.measureText(s).width)
  const lineH = 1.25 * px
  const top = (style.positionY / 100) * H - (lines.length * lineH) / 2

  lines.forEach((line, i) => {
    const y = top + i * lineH + lineH / 2
    if (style.bgOpacity > 0 && line) {
      const w = ctx.measureText(line).width + 2 * padX
      const h = 1.4 * px
      ctx.globalAlpha = style.bgOpacity / 100
      ctx.fillStyle = style.bgColor
      ctx.beginPath()
      ctx.roundRect(W / 2 - w / 2, y - h / 2, w, h, 0.15 * px)
      ctx.fill()
      ctx.globalAlpha = 1
    }
    if (style.outlineWidth > 0) {
      ctx.lineWidth = style.outlineWidth * scale * 2 // centred on the edge; the fill covers the inner half
      ctx.strokeStyle = style.outlineColor
      ctx.strokeText(line, W / 2, y)
    }
    ctx.fillStyle = style.color
    ctx.fillText(line, W / 2, y)
  })
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Renders subtitle PNGs (base64) at the export size. One canvas is reused for all of them. */
export class SubtitleRasterizer {
  private canvas = document.createElement('canvas')
  constructor(width: number, height: number) {
    this.canvas.width = width
    this.canvas.height = height
  }
  private async png(): Promise<string> {
    const blob = await new Promise<Blob | null>((resolve) => this.canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Could not encode a subtitle image')
    return toBase64(await blob.arrayBuffer())
  }
  async subtitle(text: string, style: SubtitleStyle, scale: number): Promise<string> {
    drawSubtitle(this.canvas, text, style, scale)
    return this.png()
  }
  async blank(): Promise<string> {
    this.canvas.getContext('2d')?.clearRect(0, 0, this.canvas.width, this.canvas.height)
    return this.png()
  }
}
