import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { createProject, openProject } from '../lib/actions'
import { Logo } from './Logo'

export function Welcome({ creating, onCancel, onStartNew }: { creating: boolean; onCancel(): void; onStartNew(): void }) {
  const [name, setName] = useState('Episode 001')
  const valid = name.trim().length > 0

  return (
    <div className="flex h-full flex-1 items-center justify-center bg-ink-900">
      <div className="w-[420px] rounded-lg border border-ink-600 bg-ink-800 p-8">
        <div className="mb-6 flex items-center gap-3">
          <Logo size={36} />
          <div>
            <h1 className="text-lg font-semibold leading-tight">R0-BI Studio</h1>
            <p className="text-ink-300">AI automated video production</p>
          </div>
        </div>
        {creating ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => { e.preventDefault(); if (valid) void createProject(name.trim()) }}
          >
            <label className="flex flex-col gap-1">
              <span className="text-ink-300">Project name</span>
              <input autoFocus className="field" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </label>
            <p className="text-ink-300">You will choose where to save it next. The project gets its own folder.</p>
            <div className="flex gap-2">
              <button type="submit" className="btn btn-primary" disabled={!valid}>Choose folder and create</button>
              <button type="button" className="btn" onClick={onCancel}>Cancel</button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-2">
            <button className="btn btn-primary h-10 justify-center" onClick={onStartNew}>New project</button>
            <button className="btn h-10 justify-center" onClick={() => void openProject()}><FolderOpen size={16} />Open project</button>
          </div>
        )}
      </div>
    </div>
  )
}
