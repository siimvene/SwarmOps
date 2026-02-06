import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
/**
 * PhaseAdvancer - Advance pipeline to the next phase after review approval
 * 
 * Handles:
 * - Determining the next phase to run
 * - Triggering worker spawning for the next phase
 * - Marking the pipeline as complete when all phases are done
 */

import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { parseTaskGraph, getReadyTasks, type TaskGraph } from './orchestrator'
import { triggerOrchestrator, updateProjectPhase, logActivity } from './auto-advance'
import { getPhaseState, listRunPhases, type PhaseState } from './phase-collector'

export interface AdvanceResult {
  success: boolean
  advanced: boolean
  nextPhase?: number
  message: string
  spawnedWorkers?: string[]
  pipelineComplete?: boolean
  error?: string
}

/**
 * Advance to the next phase after a review is approved and merged
 */
export async function advanceToNextPhase(opts: {
  runId: string
  completedPhaseNumber: number
  projectPath: string
  projectName: string
}): Promise<AdvanceResult> {
  const { runId, completedPhaseNumber, projectPath, projectName } = opts

  console.log(`[phase-advancer] Advancing after phase ${completedPhaseNumber} completion`)

  // Check progress.md for overall task status
  const progressPath = join(projectPath, 'progress.md')
  
  let progressContent: string
  try {
    progressContent = await readFile(progressPath, 'utf-8')
  } catch {
    return {
      success: false,
      advanced: false,
      message: 'Could not read progress.md',
      error: 'progress.md not found',
    }
  }

  const graph = parseTaskGraph(progressContent)
  const readyTasks = getReadyTasks(graph)
  const allTasks = Array.from(graph.tasks.values())
  const allDone = allTasks.every(t => t.done)

  // If all tasks are done, mark pipeline as complete
  if (allDone && allTasks.length > 0) {
    console.log(`[phase-advancer] All tasks complete, pipeline finished!`)
    
    await logActivity(
      projectPath,
      projectName,
      'pipeline-complete',
      'All phases reviewed and merged. Pipeline complete!'
    )

    await updateProjectPhase(projectPath, projectName, 'complete', 'completed')

    return {
      success: true,
      advanced: false,
      pipelineComplete: true,
      message: 'Pipeline complete - all phases reviewed and merged',
    }
  }

  // Check if there are ready tasks to spawn
  if (readyTasks.length === 0) {
    console.log(`[phase-advancer] No ready tasks to spawn`)
    
    // Check if there are pending tasks (blocked by dependencies)
    const pendingTasks = allTasks.filter(t => !t.done)
    if (pendingTasks.length > 0) {
      return {
        success: true,
        advanced: false,
        message: `Waiting for dependencies - ${pendingTasks.length} tasks pending`,
      }
    }

    return {
      success: true,
      advanced: false,
      message: 'No tasks ready to spawn',
    }
  }

  // Spawn workers for the next phase via orchestrate endpoint
  // This ensures proper phase tracking (worktrees, phase-collector, etc.)
  console.log(`[phase-advancer] ${readyTasks.length} tasks ready, calling orchestrate endpoint`)

  try {
    // Call the orchestrate endpoint directly to spawn workers with full pipeline tracking
    const response = await fetch(`http://localhost:3939/api/projects/${projectName}/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[phase-advancer] Orchestrate endpoint failed: ${errorText}`)
      return {
        success: false,
        advanced: false,
        message: `Failed to trigger orchestrator: ${response.status}`,
        error: errorText,
      }
    }

    const result = await response.json()
    
    if (result.status === 'running' && result.spawned?.length > 0) {
      await logActivity(
        projectPath,
        projectName,
        'phase-advanced',
        `Phase ${completedPhaseNumber} complete. Started phase ${result.phaseNumber} with ${result.spawned.length} workers.`,
        { 
          completedPhase: completedPhaseNumber, 
          newPhase: result.phaseNumber,
          runId: result.runId,
          spawnedWorkers: result.spawned.map((s: any) => s.taskId),
        }
      )

      return {
        success: true,
        advanced: true,
        nextPhase: result.phaseNumber,
        message: result.message,
        spawnedWorkers: result.spawned.map((s: any) => s.taskId),
      }
    }

    // All tasks might be done or blocked
    return {
      success: true,
      advanced: false,
      message: result.message || 'No tasks to spawn',
    }
  } catch (err: any) {
    console.error(`[phase-advancer] Error calling orchestrate endpoint:`, err)
    
    // Fallback to direct triggerOrchestrator (legacy)
    console.log(`[phase-advancer] Falling back to direct triggerOrchestrator`)
    const triggerResult = await triggerOrchestrator(projectPath, projectName)

    if (triggerResult.triggered) {
      await logActivity(
        projectPath,
        projectName,
        'phase-advanced',
        `Phase ${completedPhaseNumber} complete. Started next phase with ${triggerResult.details?.spawned?.length || 0} workers (fallback).`,
        { completedPhase: completedPhaseNumber, spawnedWorkers: triggerResult.details?.spawned }
      )

      return {
        success: true,
        advanced: true,
        nextPhase: completedPhaseNumber + 1,
        message: triggerResult.message,
        spawnedWorkers: triggerResult.details?.spawned || [],
      }
    }

    return {
      success: true,
      advanced: false,
      message: triggerResult.message,
    }
  }
}

/**
 * Get the status summary of all phases for a run
 */
export async function getPhasesSummary(runId: string): Promise<{
  total: number
  completed: number
  running: number
  failed: number
  phases: { number: number; status: string }[]
}> {
  const phases = await listRunPhases(runId)
  
  return {
    total: phases.length,
    completed: phases.filter(p => p.status === 'completed').length,
    running: phases.filter(p => p.status === 'running' || p.status === 'merging').length,
    failed: phases.filter(p => p.status === 'failed').length,
    phases: phases.map(p => ({ number: p.phaseNumber, status: p.status })),
  }
}

/**
 * Check if the pipeline can continue after an escalation is resolved
 */
export async function checkEscalationResolution(opts: {
  runId: string
  phaseNumber: number
  projectPath: string
  projectName: string
  resolution: 'approve' | 'skip' | 'retry'
}): Promise<AdvanceResult> {
  const { runId, phaseNumber, projectPath, projectName, resolution } = opts

  console.log(`[phase-advancer] Escalation resolved for phase ${phaseNumber}: ${resolution}`)

  switch (resolution) {
    case 'approve': {
      // Human approved the changes - advance to next phase
      return await advanceToNextPhase({
        runId,
        completedPhaseNumber: phaseNumber,
        projectPath,
        projectName,
      })
    }

    case 'skip': {
      // Skip this phase and continue with next
      await logActivity(
        projectPath,
        projectName,
        'phase-skipped',
        `Phase ${phaseNumber} skipped by human decision`
      )
      
      return await advanceToNextPhase({
        runId,
        completedPhaseNumber: phaseNumber,
        projectPath,
        projectName,
      })
    }

    case 'retry': {
      // Re-trigger the phase review
      console.log(`[phase-advancer] Retrying phase ${phaseNumber} review`)
      
      // This would need to re-trigger the review process
      // For now, return that manual intervention is needed
      return {
        success: true,
        advanced: false,
        message: 'Phase will be re-reviewed. Trigger review manually.',
      }
    }
  }
}

/**
 * Get project path and name from a run ID
 * This looks up the phase state to find the associated project
 */
export async function getProjectInfoFromRun(runId: string): Promise<{
  projectPath: string
  projectName: string
} | null> {
  // First try to get from phase state (new approach - preferred)
  const phases = await listRunPhases(runId)
  if (phases.length > 0) {
    const phase = phases[0]
    // Use explicit project info if available (set by orchestrate endpoint)
    if (phase.projectPath && phase.projectName) {
      return {
        projectPath: phase.projectPath,
        projectName: phase.projectName,
      }
    }
  }

  // Fallback: Try to get from PipelineRunner's run state
  const DATA_DIR = ORCHESTRATOR_DATA_DIR
  const runPath = join(DATA_DIR, 'runs', `${runId}.json`)
  
  try {
    const runData = await readFile(runPath, 'utf-8')
    const run = JSON.parse(runData)
    
    // Try to extract project info from run state
    if (run.projectDir) {
      const projectName = run.pipelineName || run.projectDir.split('/').pop()
      return {
        projectPath: run.projectDir,
        projectName,
      }
    }
  } catch {
    // Run file not found
  }

  // Last resort: infer from repoDir (unreliable for dashboard-based workflows)
  if (phases.length > 0 && phases[0].repoDir) {
    console.warn(`[phase-advancer] Falling back to repoDir for project info - this may be incorrect`)
    const projectName = phases[0].repoDir.split('/').pop() || 'unknown'
    return {
      projectPath: phases[0].repoDir,
      projectName,
    }
  }

  return null
}
