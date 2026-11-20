import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { R0biApi } from '../shared/api'

const api: R0biApi = {
  project: {
    create: (name) => ipcRenderer.invoke('project:new', { name }),
    open: () => ipcRenderer.invoke('project:open'),
    save: (project) => ipcRenderer.invoke('project:save', project),
    saveAs: (project) => ipcRenderer.invoke('project:saveAs', project),
    autosave: (project) => ipcRenderer.invoke('project:autosave', project)
  },
  media: {
    toolStatus: () => ipcRenderer.invoke('media:toolStatus'),
    importDialog: (existing) => ipcRenderer.invoke('media:importDialog', { existing }),
    importPaths: (paths, existing) => ipcRenderer.invoke('media:importPaths', { paths, existing }),
    refresh: (assets, haveThumbs) => ipcRenderer.invoke('media:refresh', { assets, haveThumbs }),
    relink: (asset) => ipcRenderer.invoke('media:relink', asset),
    makeProxy: (asset) => ipcRenderer.invoke('media:makeProxy', asset),
    cancelProxy: (id) => ipcRenderer.invoke('media:cancelProxy', { id }),
    waveforms: (assets) => ipcRenderer.invoke('media:waveforms', { assets }),
    getPathForFile: (file) => webUtils.getPathForFile(file)
  },
  export: {
    info: () => ipcRenderer.invoke('export:info'),
    chooseFolder: () => ipcRenderer.invoke('export:chooseFolder'),
    prepare: () => ipcRenderer.invoke('export:prepare'),
    subtitleImages: (prepId, items) => ipcRenderer.invoke('export:subtitleImages', { prepId, items }),
    enqueue: (prepId, project, settings, cueImages, projectToken) => ipcRenderer.invoke('export:enqueue', { prepId, project, settings, cueImages, projectToken }),
    list: () => ipcRenderer.invoke('export:list'),
    cancel: (id) => ipcRenderer.invoke('export:cancel', { id }),
    clearFinished: () => ipcRenderer.invoke('export:clear'),
    reveal: (id) => ipcRenderer.invoke('export:reveal', { id }),
    onUpdate: (cb) => {
      const handler = (_event: unknown, jobs: Parameters<typeof cb>[0]) => cb(jobs)
      ipcRenderer.on('export:update', handler)
      return () => void ipcRenderer.removeListener('export:update', handler)
    }
  },
  automation: {
    load: () => ipcRenderer.invoke('automation:load'),
    save: (kind, item) => ipcRenderer.invoke('automation:save', { kind, item }),
    remove: (kind, id) => ipcRenderer.invoke('automation:remove', { kind, id }),
    pickProjects: () => ipcRenderer.invoke('automation:pickProjects')
  },
  ai: {
    getSettings: () => ipcRenderer.invoke('ai:getSettings'),
    saveSettings: (change) => ipcRenderer.invoke('ai:saveSettings', change),
    test: () => ipcRenderer.invoke('ai:test'),
    plan: (req) => ipcRenderer.invoke('ai:plan', req),
    cancel: () => ipcRenderer.invoke('ai:cancel')
  },
  subtitles: {
    importDialog: () => ipcRenderer.invoke('subtitles:importDialog')
  },
  app: {
    setDirty: (dirty) => ipcRenderer.send('app:set-dirty', dirty === true)
  }
}

contextBridge.exposeInMainWorld('r0bi', api)
