import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
import { readFile } from 'fs/promises'
import { join } from 'path'

const DATA_DIR = ORCHESTRATOR_DATA_DIR

interface Task {
  id: string
  pipelineId: string
  pipelineName: string
  runId: string
  stepOrder: number
  roleId: string
  roleName: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  createdAt: string
  startedAt?: string
  completedAt?: string
  sessionKey?: string
  result?: string
  error?: string
}

export default defineEventHandler(async (): Promise<Task[]> => {
  const filePath = join(DATA_DIR, 'work-queue.json')
  
  try {
    const content = await readFile(filePath, 'utf-8')
    const tasks: Task[] = JSON.parse(content)
    
    // Return pending/running first, then by creation date
    return tasks.sort((a, b) => {
      const statusOrder = { pending: 0, running: 1, completed: 2, failed: 3 }
      const statusDiff = (statusOrder[a.status] || 99) - (statusOrder[b.status] || 99)
      if (statusDiff !== 0) return statusDiff
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    })
  } catch {
    // Return empty if file doesn't exist
    return []
  }
})
