export interface ParsedCue {
  startMs: number
  endMs: number
  text: string
}
export interface SrtResult {
  cues: ParsedCue[]
  /** Human-readable problems that did not stop the import. */
  warnings: string[]
}

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/

const toMs = (h: string, m: string, s: string, ms: string) =>
  Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + Number(ms.padEnd(3, '0'))

/** Parse SubRip (.srt) text. Tolerant of BOMs, CRLF, missing index lines, and "." as the decimal mark. */
export function parseSrt(input: string): SrtResult {
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const cues: ParsedCue[] = []
  const warnings: string[] = []
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l, i, a) => !(l.trim() === '' && (i === 0 || i === a.length - 1)))
    if (lines.length === 0) continue
    const at = lines.findIndex((l) => TIME.test(l))
    if (at === -1 || at > 1) {
      if (block.trim()) warnings.push(`Skipped a block without a valid time range: "${block.trim().slice(0, 30)}"`)
      continue
    }
    const m = TIME.exec(lines[at]) as RegExpExecArray
    const startMs = toMs(m[1], m[2], m[3], m[4])
    const endMs = toMs(m[5], m[6], m[7], m[8])
    const body = lines
      .slice(at + 1)
      .join('\n')
      .replace(/<\/?[a-zA-Z][^>]*>/g, '') // <i>, <b>, <font ...>
      .replace(/\{\\[^}]*\}/g, '') // {\an8} style overrides
      .trim()
    if (endMs <= startMs) {
      warnings.push(`Skipped a cue with an end before its start at ${lines[at].trim()}`)
      continue
    }
    cues.push({ startMs, endMs, text: body })
  }
  cues.sort((a, b) => a.startMs - b.startMs)
  return { cues, warnings }
}

/** Convert parsed cues to integer frames; overlaps are fixed by ending the earlier cue where the next begins. */
export function cuesToFrames(cues: readonly ParsedCue[], fps: number): { startFrame: number; durationFrames: number; text: string }[] {
  const out: { startFrame: number; durationFrames: number; text: string }[] = []
  for (const c of cues) {
    const startFrame = Math.round((c.startMs * fps) / 1000)
    const endFrame = Math.max(startFrame + 1, Math.round((c.endMs * fps) / 1000))
    const prev = out[out.length - 1]
    if (prev && prev.startFrame + prev.durationFrames > startFrame) {
      prev.durationFrames = startFrame - prev.startFrame
      if (prev.durationFrames < 1) {
        // Two cues start on the same frame: push the later one back so both survive.
        prev.durationFrames = 1
        out.push({ startFrame: startFrame + 1, durationFrames: Math.max(1, endFrame - startFrame - 1), text: c.text })
        continue
      }
    }
    out.push({ startFrame, durationFrames: endFrame - startFrame, text: c.text })
  }
  return out
}

/** Decode a subtitle file: UTF-8 (with or without BOM) or UTF-16 with BOM, as Windows tools often save. */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  return new TextDecoder('utf-8').decode(bytes)
}
