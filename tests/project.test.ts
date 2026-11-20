import { describe, expect, it } from 'vitest'
import { createEmptyProject, migrateProject, ProjectSchema } from '../shared/project'
import { framesToTimecode, secondsToFrames } from '../shared/time'

describe('project schema', () => {
  it('creates a valid default project with the expected tracks', () => {
    const p = createEmptyProject('  Episode 001 ')
    expect(ProjectSchema.safeParse(p).success).toBe(true)
    expect(p.name).toBe('Episode 001')
    expect(p.settings).toEqual({ width: 1920, height: 1080, fps: 30 })
    expect(p.tracks.map((t) => t.name)).toEqual(['Overlay 1', 'Subtitles 1', 'Video 1', 'Video 2', 'Audio 1', 'Audio 2'])
  })

  it('round-trips through JSON', () => {
    const p = createEmptyProject('A')
    expect(migrateProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
  })

  it('rejects projects from a newer schema version', () => {
    const p = { ...createEmptyProject('A'), schemaVersion: 99 }
    expect(() => migrateProject(p)).toThrow(/newer version/)
  })

  it('rejects damaged data', () => {
    expect(() => migrateProject({ schemaVersion: 1, name: 5 })).toThrow()
    expect(() => migrateProject(null)).toThrow()
  })
})

describe('time', () => {
  it('formats integer frames as timecode without drift', () => {
    expect(framesToTimecode(0, 30)).toBe('00:00:00:00')
    expect(framesToTimecode(29, 30)).toBe('00:00:00:29')
    expect(framesToTimecode(30, 30)).toBe('00:00:01:00')
    expect(framesToTimecode(30 * 3661 + 7, 30)).toBe('01:01:01:07')
    expect(secondsToFrames(1.5, 24)).toBe(36)
  })
})
