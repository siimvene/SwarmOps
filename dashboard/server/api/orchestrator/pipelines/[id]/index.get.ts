import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
import { readFile } from 'fs/promises'
import { join } from 'path'

const DATA_DIR = ORCHESTRATOR_DATA_DIR

interface Pipeline {
  id: string
  name: string
  description?: string
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error'
  graph?: {
    nodes: unknown[]
    edges: unknown[]
    viewport?: { x: number; y: number; zoom: number }
  }
  createdAt: string
  updatedAt?: string
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Pipeline ID required' })
  }

  const filePath = join(DATA_DIR, 'pipelines.json')
  
  try {
    const data = await readFile(filePath, 'utf-8')
    const pipelines: Pipeline[] = JSON.parse(data)
    const pipeline = pipelines.find(p => p.id === id)
    
    if (!pipeline) {
      throw createError({ statusCode: 404, statusMessage: 'Pipeline not found' })
    }
    
    return pipeline
  } catch (error: unknown) {
    if ((error as { statusCode?: number }).statusCode === 404) throw error
    throw createError({ statusCode: 404, statusMessage: 'Pipeline not found' })
  }
})
