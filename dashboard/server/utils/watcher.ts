import { watch, type FSWatcher } from 'fs'
import { readdir, stat } from 'fs/promises'
import { join, relative, basename } from 'path'
import { PROJECTS_DIR } from './paths'

export interface FileChangeEvent {
  type: 'project-update'
  project: string
  file: string
  timestamp: number
}

type ChangeHandler = (event: FileChangeEvent) => void
const DEBOUNCE_MS = 100

class ProjectWatcher {
  private watchers: Map<string, FSWatcher[]> = new Map()
  private handlers: Set<ChangeHandler> = new Set()
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map()
  private initialized = false

  async init() {
    if (this.initialized) return
    this.initialized = true

    try {
      const entries = await readdir(PROJECTS_DIR, { withFileTypes: true })
      const projects = entries.filter((e: { isDirectory: () => boolean }) => e.isDirectory()).map((e: { name: string }) => e.name)

      for (const project of projects) {
        await this.watchProject(project)
      }

      console.log(`[watcher] Watching ${projects.length} projects in ${PROJECTS_DIR}`)
    } catch (err) {
      console.error('[watcher] Failed to init:', err)
    }
  }

  private async watchProject(project: string) {
    const projectDir = join(PROJECTS_DIR, project)
    const projectWatchers: FSWatcher[] = []

    const filesToWatch = ['state.json', 'progress.md']
    for (const file of filesToWatch) {
      try {
        const filePath = join(projectDir, file)
        await stat(filePath)
        const watcher = watch(filePath, () => this.emitChange(project, file))
        projectWatchers.push(watcher)
      } catch {}
    }

    const logsDir = join(projectDir, 'logs')
    try {
      await stat(logsDir)
      const watcher = watch(logsDir, (_: string, filename: string | null) => {
        if (filename?.endsWith('.json')) {
          this.emitChange(project, `logs/${filename}`)
        }
      })
      projectWatchers.push(watcher)
    } catch {}

    this.watchers.set(project, projectWatchers)
  }

  private emitChange(project: string, file: string) {
    const key = `${project}:${file}`
    const existing = this.debounceTimers.get(key)
    if (existing) clearTimeout(existing)

    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key)
      const event: FileChangeEvent = {
        type: 'project-update',
        project,
        file,
        timestamp: Date.now()
      }
      this.handlers.forEach(h => h(event))
    }, DEBOUNCE_MS))
  }

  subscribe(handler: ChangeHandler) {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  destroy() {
    for (const watchers of this.watchers.values()) {
      watchers.forEach(w => w.close())
    }
    this.watchers.clear()
    this.debounceTimers.forEach(t => clearTimeout(t))
    this.debounceTimers.clear()
  }
}

export const projectWatcher = new ProjectWatcher()
