import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { requireAuth } from '../../../utils/security'

const DATA_DIR = ORCHESTRATOR_DATA_DIR

interface PipelineStep {
  id: string
  order: number
  roleId: string
  roleName?: string
  action: string
  convergence?: {
    maxIterations?: number
    targetScore?: number
  }
}

interface PipelineGraph {
  nodes: unknown[]
  edges: unknown[]
  viewport?: { x: number; y: number; zoom: number }
}

interface Pipeline {
  id: string
  name: string
  description?: string
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error'
  steps: PipelineStep[]
  graph?: PipelineGraph
  createdAt: string
  updatedAt?: string
  lastRunAt?: string
}

export default defineEventHandler(async (event) => {
  requireAuth(event)
  const id = getRouterParam(event, 'id')
  const body = await readBody(event)
  
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

  pipelines[index] = {
    ...pipelines[index],
    name: body.name || pipelines[index].name,
    description: body.description ?? pipelines[index].description,
    steps: body.steps || pipelines[index].steps,
    graph: body.graph ?? pipelines[index].graph,
    updatedAt: new Date().toISOString()
  }

  await writeFile(filePath, JSON.stringify(pipelines, null, 2))
  return pipelines[index]
})
