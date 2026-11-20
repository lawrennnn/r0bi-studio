# Architecture

```
electron/main.ts          window, dialogs, validated IPC handlers, logging, close guard
electron/preload.ts       contextBridge: exposes window.r0bi (typed by shared/api.ts)
electron/projectManager.ts  project folder, atomic save, backups, autosave, recovery, save-as
shared/project.ts         Zod schema, migrations, Result type (used by main AND renderer)
shared/time.ts            integer-frame timecode helpers
src/store/projectStore.ts project state + undo/redo (snapshot history, 100 deep)
src/store/uiStore.ts      panel sizes, tabs, zoom, playhead (frames)
src/components/*          TopBar, LeftSidebar, Preview, RightSidebar, Timeline, Welcome
```

## Security
contextIsolation on, nodeIntegration off, sandbox on. Every IPC handler checks the sender is the main window and validates input with Zod. The renderer never sends file paths: the main process owns the current project folder and opens dialogs itself. Production builds ship a strict CSP. Navigation and window.open are blocked.

## Project folder
```
<project>/project.json  assets/{video,audio,images,subtitles,thumbnails}  exports/  backups/
```
Saves are atomic (write temp, rename). Each save copies the previous project.json into backups/ (last 10 kept). Autosave writes backups/autosave.json; opening a project with a newer autosave offers recovery.
