import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { requireAuth } from '../../../utils/security'

const DATA_DIR = ORCHESTRATOR_DATA_DIR

interface Pipeline {
  id: string
  name: string
  description?: string
  status: string
  steps: unknown[]
  createdAt: string
  lastRunAt?: string
}

export default defineEventHandler(async (event) => {
  requireAuth(event)
  const id = getRouterParam(event, 'id')
  
  const filePath = join(DATA_DIR, 'pipelines.json')
  let pipelines: Pipeline[] = []
  
  try {
    const data = await readFile(filePath, 'utf-8')
    pipelines = JSON.parse(data)
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'Pipeline not found' })
  }

  const index = pipelines.findIndex(p => p.id === id)
  if (index === -1) {
    throw createError({ statusCode: 404, statusMessage: 'Pipeline not found' })
  }

  const deleted = pipelines.splice(index, 1)[0]
  await writeFile(filePath, JSON.stringify(pipelines, null, 2))
  
  return { success: true, deleted }
})
