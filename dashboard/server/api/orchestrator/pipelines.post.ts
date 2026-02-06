import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { requireAuth } from '../../utils/security'

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
  const body = await readBody(event)
  
  if (!body.name) {
    throw createError({ statusCode: 400, statusMessage: 'Name is required' })
  }

  await mkdir(DATA_DIR, { recursive: true })
  const filePath = join(DATA_DIR, 'pipelines.json')
  let pipelines: Pipeline[] = []
  
  try {
    const data = await readFile(filePath, 'utf-8')
    pipelines = JSON.parse(data)
  } catch {}

  const now = new Date().toISOString()
  const newPipeline: Pipeline = {
    id: randomUUID(),
    name: body.name,
    description: body.description || '',
    status: 'idle',
    steps: (body.steps || []).map((step: PipelineStep, idx: number) => ({
      id: step.id || randomUUID(),
      order: idx + 1,
      roleId: step.roleId,
      roleName: step.roleName,
      action: step.action || 'execute',
      convergence: step.convergence
    })),
    graph: body.graph || undefined,
    createdAt: now,
    updatedAt: now
  }

  pipelines.push(newPipeline)
  await writeFile(filePath, JSON.stringify(pipelines, null, 2))

  return newPipeline
})
