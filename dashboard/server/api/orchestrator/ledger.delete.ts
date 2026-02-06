import { readdir, unlink } from 'fs/promises'
import { join } from 'path'
import { PROJECTS_DIR } from '../../utils/paths'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const projectsDir = config.projectsDir || PROJECTS_DIR

  try {
    const entries = await readdir(projectsDir, { withFileTypes: true })
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'))

    let deleted = 0

    await Promise.all(
      dirs.map(async (dir) => {
        const activityPath = join(projectsDir, dir.name, 'activity.jsonl')
        try {
          await unlink(activityPath)
          deleted++
        } catch {
          // File doesn't exist or can't be deleted - skip
        }
      })
    )

    return { success: true, deleted }
  } catch (err) {
    console.error('[ledger] Failed to delete activity files:', err)
    throw createError({ statusCode: 500, message: 'Failed to delete ledger' })
  }
})
