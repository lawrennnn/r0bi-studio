# R0-BI Studio: Master Plan

AI automated video production studio for Windows. Electron + React + TypeScript + Vite + Tailwind, Zustand, Zod, SQLite, Remotion, FFmpeg. AI (Claude API) is optional.

## Phases
1. Foundation: shell, secure IPC, layout, project manager, save/load **(done)**
2. Media management: import, ffprobe metadata, thumbnails, library, relinking, proxies **(done, see DEVELOPMENT_STATUS.md)**
3. Timeline: clips, drag, trim, snapping, undo/redo for clip edits **(done, see DEVELOPMENT_STATUS.md)**
4. Preview: playback, seeking, composition **(done, see DEVELOPMENT_STATUS.md)**
5. Audio and subtitles: mixing, fades, SRT, styling **(done, see DEVELOPMENT_STATUS.md)**
6. Rendering: FFmpeg export, NVENC detection, queue, cancel, ffprobe verification **(done, see DEVELOPMENT_STATUS.md)**
7. AI assistant: Claude API, validated command schema, review/approve/execute **(done, see DEVELOPMENT_STATUS.md)**
8. Automation: templates, reusable scenes, batch export **(done, see DEVELOPMENT_STATUS.md)**
9. Testing and release: integration tests, perf, security review, NSIS installer

## Rules
- Integer frames for all timeline time.
- Renderer never touches the filesystem; all paths come from main-process dialogs.
- Never modify imported source media.
- A feature is done only when its behaviour works and is tested.
