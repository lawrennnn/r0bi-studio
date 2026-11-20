import type { Project } from '@shared/project'

/** Changes whenever the set of media files (or their proxies) the preview may load changes. */
export function libraryKey(p: Pick<Project, 'media'> | null): string {
  return p ? p.media.map((a) => `${a.id}|${a.path}|${a.proxy ?? ''}`).join('\n') : ''
}
