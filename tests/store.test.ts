import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyProject } from '../shared/project'
import { editProject, useProjectStore } from '../src/store/projectStore'

const load = () => useProjectStore.getState().load(createEmptyProject('T'), '/tmp/t')
const s = () => useProjectStore.getState()

describe('project store undo/redo', () => {
  beforeEach(load)

  it('marks dirty and supports undo/redo of edits', () => {
    expect(s().status).toBe('saved')
    editProject.rename('Renamed')
    editProject.addTrack('audio')
    expect(s().status).toBe('dirty')
    expect(s().project?.tracks).toHaveLength(7)

    s().undo()
    expect(s().project?.tracks).toHaveLength(6)
    s().undo()
    expect(s().project?.name).toBe('T')
    s().redo()
    expect(s().project?.name).toBe('Renamed')
  })

  it('clears redo history after a new edit', () => {
    editProject.rename('A')
    s().undo()
    expect(s().future).toHaveLength(1)
    editProject.rename('B')
    expect(s().future).toHaveLength(0)
  })

  it('inserts new tracks next to tracks of the same kind', () => {
    editProject.addTrack('video')
    const names = s().project!.tracks.map((t) => t.name)
    expect(names).toEqual(['Overlay 1', 'Subtitles 1', 'Video 1', 'Video 2', 'Video 3', 'Audio 1', 'Audio 2'])
  })

  it('toggles track state', () => {
    const id = s().project!.tracks[0].id
    editProject.toggleTrack(id, 'locked')
    expect(s().project!.tracks[0].locked).toBe(true)
  })

  it('stays dirty if edited while a save was in flight', () => {
    const rev = s().revision
    editProject.rename('During save')
    s().markSaved(s().project!, rev)
    expect(s().status).toBe('dirty')
    s().markSaved(s().project!, s().revision)
    expect(s().status).toBe('saved')
  })
})
