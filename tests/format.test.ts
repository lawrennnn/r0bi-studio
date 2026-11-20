import { describe, expect, it } from 'vitest'
import { formatBytes, formatDuration, formatFps } from '../src/lib/format'

describe('format helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(65_400)).toBe('1:05')
    expect(formatDuration(3_725_000)).toBe('1:02:05')
  })
  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB')
  })
  it('formats exact frame rates', () => {
    expect(formatFps(30000, 1001)).toBe('29.97 fps')
    expect(formatFps(30, 1)).toBe('30 fps')
    expect(formatFps(0, 0)).toBe('—')
  })
})
