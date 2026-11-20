import { describe, expect, it } from 'vitest'
import { breakLines } from '../src/lib/subtitleRaster'

const width = (s: string) => [...s].length * 10 // every character is 10 px wide

describe('subtitle line breaking', () => {
  it('keeps short text on one line and respects explicit new lines', () => {
    expect(breakLines('Hello world', 200, width)).toEqual(['Hello world'])
    expect(breakLines('One\nTwo', 200, width)).toEqual(['One', 'Two'])
    expect(breakLines('A\r\nB', 200, width)).toEqual(['A', 'B'])
  })
  it('wraps at word boundaries without leaving trailing spaces', () => {
    expect(breakLines('The quick brown fox jumps', 120, width)).toEqual(['The quick', 'brown fox', 'jumps'])
  })
  it('splits a single word that is wider than the line', () => {
    const lines = breakLines('Supercalifragilistic', 80, width)
    expect(lines.join('')).toBe('Supercalifragilistic')
    expect(lines.every((l) => width(l) <= 80)).toBe(true)
  })
  it('wraps Khmer text, which has no spaces, without losing or splitting characters', () => {
    const text = 'សួស្តី ពិភពលោក ខ្ញុំស្រលាញ់ប្រទេសកម្ពុជា'
    const lines = breakLines(text, 150, width)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join(' ').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''))
  })
  it('returns one empty line for empty text', () => {
    expect(breakLines('', 100, width)).toEqual([''])
  })
})
