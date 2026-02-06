import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

const DATA_DIR = ORCHESTRATOR_DATA_DIR
const RUNS_DIR = join(DATA_DIR, 'runs')

interface StepResult {
  stepId: string
  stepOrder: number
  status: 'completed' | 'failed'
  output?: string
  error?: string
  completedAt: string
}

interface RunState {
  runId: string
  pipelineId: string
  pipelineName: string
  status: 'running' | 'completed' | 'failed'
  currentStepIndex: number
  totalSteps: number
  stepResults: StepResult[]
  startedAt: string
  completedAt?: string
}

interface RunSummary {
  runId: string
  status: 'running' | 'completed' | 'failed'
  totalSteps: number
  completedSteps: number
  failedSteps: number
  startedAt: string
  completedAt?: string
  duration?: number
}

export default defineEventHandler(async (event) => {
  const pipelineId = getRouterParam(event, 'id')
  const query = getQuery(event)
  const limit = Math.min(parseInt(query.limit as string) || 20, 100)

  const runs: RunSummary[] = []

  try {
    const files = await readdir(RUNS_DIR)
    const jsonFiles = files.filter(f => f.endsWith('.json')).sort().reverse()

    for (const file of jsonFiles) {
      if (runs.length >= limit) break

      try {
        const data = await readFile(join(RUNS_DIR, file), 'utf-8')
        const run: RunState = JSON.parse(data)

        if (run.pipelineId !== pipelineId) continue

        const completedSteps = run.stepResults.filter(r => r.status === 'completed').length
        const failedSteps = run.stepResults.filter(r => r.status === 'failed').length
        
        let duration: number | undefined
        if (run.completedAt && run.startedAt) {
          duration = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
        } else if (run.startedAt && run.status === 'running') {
          duration = Date.now() - new Date(run.startedAt).getTime()
        }

        runs.push({
          runId: run.runId,
          status: run.status,
          totalSteps: run.totalSteps,
          completedSteps,
          failedSteps,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          duration,
        })
      } catch {
        // Skip invalid files
      }
    }
  } catch {
    // RUNS_DIR doesn't exist yet
  }

  return runs
})
