import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

interface ActivityEvent {
  id: string
  timestamp: string
  type: string
  message: string
  agent?: string
  taskId?: string
  phaseNumber?: number
  workerId?: string
  workerBranch?: string
  runId?: string
  success?: boolean
  mergeStatus?: string
  allSucceeded?: boolean
  error?: string
  /** Injected by this endpoint */
  projectName?: string
}

export default defineEventHandler(async (event): Promise<ActivityEvent[]> => {
  const config = useRuntimeConfig(event)
  const projectsDir = config.projectsDir || process.env.PROJECTS_DIR || './projects'

  try {
    const entries = await readdir(projectsDir, { withFileTypes: true })
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'))

    const allEvents: ActivityEvent[] = []

    await Promise.all(
      dirs.map(async (dir) => {
        const activityPath = join(projectsDir, dir.name, 'activity.jsonl')
        try {
          const content = await readFile(activityPath, 'utf-8')
          const lines = content.trim().split('\n').filter(l => l.trim())

          for (const line of lines) {
            try {
              const ev: ActivityEvent = JSON.parse(line)
              ev.projectName = dir.name
              allEvents.push(ev)
            } catch {
              // Skip invalid lines
            }
          }
        } catch {
          // No activity file for this project - skip
        }
      })
    )

    // Sort by timestamp descending (newest first), limit to 200
    allEvents.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
    return allEvents.slice(0, 200)
  } catch (err) {
    console.error('[ledger] Failed to aggregate activity:', err)
    return []
  }
})
