import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { PipelineRunner, type Pipeline, type Role } from '../../../../utils/pipeline-runner'
import { requireAuth } from '../../../../utils/security'

const DATA_DIR = ORCHESTRATOR_DATA_DIR

export default defineEventHandler(async (event) => {
  requireAuth(event)
  const id = getRouterParam(event, 'id')
  const body = await readBody(event).catch(() => ({}))
  
  // Load pipeline
  const pipelinesPath = join(DATA_DIR, 'pipelines.json')
  let pipelines: Pipeline[] = []
  
  try {
    const data = await readFile(pipelinesPath, 'utf-8')
    pipelines = JSON.parse(data)
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'Pipeline not found' })
  }

  const pipelineIndex = pipelines.findIndex(p => p.id === id)
  if (pipelineIndex === -1) {
    throw createError({ statusCode: 404, statusMessage: 'Pipeline not found' })
  }

  const pipeline = pipelines[pipelineIndex]
  
  // Load roles for instructions/model
  let roles: Role[] = []
  try {
    const rolesData = await readFile(join(DATA_DIR, 'roles.json'), 'utf-8')
    roles = JSON.parse(rolesData)
  } catch {
    roles = [
      { id: 'builder', name: 'builder', model: 'anthropic/claude-sonnet-4-20250514', thinking: 'low', instructions: 'You are a builder. Implement the task.' },
      { id: 'reviewer', name: 'reviewer', model: 'anthropic/claude-sonnet-4-20250514', thinking: 'medium', instructions: 'You are a reviewer. Review the work.' },
    ]
  }

  // Get project context from body or use pipeline name
  const projectContext = body.projectContext || `Pipeline: ${pipeline.name}`
  const projectDir = body.projectDir || ''

  // Update pipeline status
  pipelines[pipelineIndex].status = 'running'
  pipelines[pipelineIndex].lastRunAt = new Date().toISOString()
  pipelines[pipelineIndex].currentStep = 1
  await writeFile(pipelinesPath, JSON.stringify(pipelines, null, 2))

  // Start sequential run - only spawns first step
  const result = await PipelineRunner.startRun(pipeline, roles, {
    projectContext,
    projectDir,
  })

  if (result.error) {
    pipelines[pipelineIndex].status = 'error'
    await writeFile(pipelinesPath, JSON.stringify(pipelines, null, 2))
    
    return {
      success: false,
      error: result.error,
      pipeline: pipelines[pipelineIndex],
    }
  }

  return {
    success: true,
    runId: result.runId,
    firstSession: result.firstSession,
    pipeline: pipelines[pipelineIndex],
    message: `Started sequential run. Step 1 of ${pipeline.steps.length} spawned.`,
  }
})
