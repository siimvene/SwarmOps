import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
/**
 * PhaseCollector - Collect worker branches when all phase workers complete
 * 
 * Tracks workers per phase and triggers branch collection/merge preparation
 * when all workers in a phase have finished their work.
 */

import { exec as execCallback } from 'child_process'
import { promisify } from 'util'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { listRunWorktrees, getWorkerBranch } from './worktree-manager'
import {
  branchExists,
  checkoutBranch,
  createBranch,
  getPhaseBranch,
} from './conflict-resolver'

const exec = promisify(execCallback)

const DATA_DIR = ORCHESTRATOR_DATA_DIR
const PHASES_DIR = join(DATA_DIR, 'phases')

export interface PhaseWorker {
  workerId: string
  taskId: string
  taskDescription?: string  // Human-readable task description for conflict resolution
  branch: string
  status: 'running' | 'completed' | 'failed'
  completedAt?: string
  output?: string
  error?: string
}

export interface PhaseState {
  runId: string
  phaseNumber: number
  repoDir: string
  baseBranch: string
  workers: PhaseWorker[]
  status: 'running' | 'collecting' | 'merging' | 'completed' | 'failed'
  phaseBranch?: string
  collectedBranches?: string[]
  startedAt: string
  completedAt?: string
  // Project context for pipeline advancement
  projectPath?: string  // Path where progress.md lives (e.g., {projectsDir}/{name})
  projectName?: string  // Project name for API calls
}

// In-memory store for active phases
const activePhases = new Map<string, PhaseState>()

/**
 * Get phase key for storage lookup
 */
function getPhaseKey(runId: string, phaseNumber: number): string {
  return `${runId}:phase-${phaseNumber}`
}

/**
 * Initialize a new phase with workers
 */
export async function initPhase(opts: {
  runId: string
  phaseNumber: number
  repoDir: string
  baseBranch: string
  workerIds: string[]
  taskIds: string[]
  taskDescriptions?: string[]  // Human-readable task descriptions for conflict resolution
  projectPath?: string  // Path where progress.md lives
  projectName?: string  // Project name for API calls
}): Promise<PhaseState> {
  const { runId, phaseNumber, repoDir, baseBranch, workerIds, taskIds, taskDescriptions, projectPath, projectName } = opts
  const key = getPhaseKey(runId, phaseNumber)

  const workers: PhaseWorker[] = workerIds.map((workerId, i) => ({
    workerId,
    taskId: taskIds[i] || workerId,
    taskDescription: taskDescriptions?.[i],
    branch: getWorkerBranch(runId, workerId),
    status: 'running',
  }))

  const state: PhaseState = {
    runId,
    phaseNumber,
    repoDir,
    baseBranch,
    workers,
    status: 'running',
    startedAt: new Date().toISOString(),
    projectPath,
    projectName,
  }

  activePhases.set(key, state)
  await savePhaseState(state)

  console.log(`[phase-collector] Initialized phase ${phaseNumber} with ${workers.length} workers for project ${projectName || 'unknown'}`)
  return state
}

/**
 * Mark a worker as completed
 * Returns true if this was the last worker (phase ready for collection)
 */
export async function onWorkerComplete(opts: {
  runId: string
  phaseNumber: number
  workerId: string
  status: 'completed' | 'failed'
  output?: string
  error?: string
}): Promise<{ phaseComplete: boolean; allSucceeded: boolean; phaseState: PhaseState }> {
  const { runId, phaseNumber, workerId, status, output, error } = opts
  const key = getPhaseKey(runId, phaseNumber)

  let state = activePhases.get(key)
  if (!state) {
    state = await loadPhaseState(runId, phaseNumber)
    if (!state) {
      throw new Error(`Phase ${phaseNumber} not found for run ${runId}`)
    }
    activePhases.set(key, state)
  }

  // Find and update the worker
  const worker = state.workers.find(w => w.workerId === workerId)
  if (!worker) {
    throw new Error(`Worker ${workerId} not found in phase ${phaseNumber}`)
  }

  worker.status = status
  worker.completedAt = new Date().toISOString()
  worker.output = output
  worker.error = error

  await savePhaseState(state)

  // Check if all workers are done
  const allDone = state.workers.every(w => w.status !== 'running')
  const allSucceeded = state.workers.every(w => w.status === 'completed')

  console.log(`[phase-collector] Worker ${workerId} ${status}. Phase ${phaseNumber}: ${allDone ? 'complete' : 'still running'}`)

  return { phaseComplete: allDone, allSucceeded, phaseState: state }
}

/**
 * Collect all completed worker branches for a phase
 * Creates a phase branch and returns the branches to merge
 */
export async function collectPhaseBranches(opts: {
  runId: string
  phaseNumber: number
}): Promise<{
  success: boolean
  phaseBranch?: string
  workerBranches?: string[]
  error?: string
}> {
  const { runId, phaseNumber } = opts
  const key = getPhaseKey(runId, phaseNumber)

  let state = activePhases.get(key)
  if (!state) {
    state = await loadPhaseState(runId, phaseNumber)
    if (!state) {
      return { success: false, error: `Phase ${phaseNumber} not found for run ${runId}` }
    }
    activePhases.set(key, state)
  }

  // Verify all workers completed successfully
  const failedWorkers = state.workers.filter(w => w.status === 'failed')
  if (failedWorkers.length > 0) {
    const failedIds = failedWorkers.map(w => w.workerId).join(', ')
    return { success: false, error: `Workers failed: ${failedIds}` }
  }

  const runningWorkers = state.workers.filter(w => w.status === 'running')
  if (runningWorkers.length > 0) {
    const runningIds = runningWorkers.map(w => w.workerId).join(', ')
    return { success: false, error: `Workers still running: ${runningIds}` }
  }

  state.status = 'collecting'

  // Get branch names for all workers
  const workerBranches: string[] = []
  for (const worker of state.workers) {
    const exists = await branchExists(state.repoDir, worker.branch)
    if (!exists) {
      // Worker may not have made changes - check if there are commits
      console.log(`[phase-collector] Branch ${worker.branch} not found, worker may have made no changes`)
      continue
    }

    // Verify branch has commits beyond base
    const hasChanges = await branchHasNewCommits(state.repoDir, worker.branch, state.baseBranch)
    if (hasChanges) {
      workerBranches.push(worker.branch)
    } else {
      console.log(`[phase-collector] Branch ${worker.branch} has no new commits, skipping`)
    }
  }

  if (workerBranches.length === 0) {
    console.log(`[phase-collector] No branches to collect for phase ${phaseNumber}`)
    state.status = 'completed'
    state.completedAt = new Date().toISOString()
    state.collectedBranches = []
    await savePhaseState(state)
    return { success: true, workerBranches: [] }
  }

  // Create phase branch from base
  const phaseBranch = getPhaseBranch(runId, phaseNumber)
  
  // Delete existing phase branch if it exists (from previous failed attempt)
  try {
    const exists = await branchExists(state.repoDir, phaseBranch)
    if (exists) {
      await exec(`git branch -D "${phaseBranch}"`, { cwd: state.repoDir })
    }
  } catch {
    // Ignore
  }

  // Create fresh phase branch from base
  const createResult = await createBranch(state.repoDir, phaseBranch, state.baseBranch)
  if (!createResult.success) {
    return { success: false, error: `Failed to create phase branch: ${createResult.error}` }
  }

  // Switch back to base to not interfere
  await checkoutBranch(state.repoDir, state.baseBranch)

  state.phaseBranch = phaseBranch
  state.collectedBranches = workerBranches
  await savePhaseState(state)

  console.log(`[phase-collector] Collected ${workerBranches.length} branches for phase ${phaseNumber}`)
  console.log(`[phase-collector] Phase branch: ${phaseBranch}`)
  console.log(`[phase-collector] Worker branches: ${workerBranches.join(', ')}`)

  return {
    success: true,
    phaseBranch,
    workerBranches,
  }
}

/**
 * Check if a branch has commits beyond the base branch
 */
async function branchHasNewCommits(
  repoDir: string,
  branch: string,
  baseBranch: string
): Promise<boolean> {
  try {
    const { stdout } = await exec(
      `git rev-list --count ${baseBranch}..${branch}`,
      { cwd: repoDir }
    )
    const count = parseInt(stdout.trim(), 10)
    return count > 0
  } catch {
    return false
  }
}

/**
 * Mark phase as completed after successful merge
 */
export async function completePhase(opts: {
  runId: string
  phaseNumber: number
}): Promise<void> {
  const { runId, phaseNumber } = opts
  const key = getPhaseKey(runId, phaseNumber)

  let state = activePhases.get(key)
  if (!state) {
    state = await loadPhaseState(runId, phaseNumber)
  }
  if (!state) return

  state.status = 'completed'
  state.completedAt = new Date().toISOString()
  await savePhaseState(state)

  // Remove from active phases
  activePhases.delete(key)

  console.log(`[phase-collector] Phase ${phaseNumber} completed`)
}

/**
 * Mark phase as failed
 */
export async function failPhase(opts: {
  runId: string
  phaseNumber: number
  error: string
}): Promise<void> {
  const { runId, phaseNumber, error } = opts
  const key = getPhaseKey(runId, phaseNumber)

  let state = activePhases.get(key)
  if (!state) {
    state = await loadPhaseState(runId, phaseNumber)
  }
  if (!state) return

  state.status = 'failed'
  state.completedAt = new Date().toISOString()
  await savePhaseState(state)

  console.log(`[phase-collector] Phase ${phaseNumber} failed: ${error}`)
}

/**
 * Get phase state
 */
export async function getPhaseState(
  runId: string,
  phaseNumber: number
): Promise<PhaseState | null> {
  const key = getPhaseKey(runId, phaseNumber)
  return activePhases.get(key) || await loadPhaseState(runId, phaseNumber)
}

/**
 * List all phases for a run
 */
export async function listRunPhases(runId: string): Promise<PhaseState[]> {
  const phases: PhaseState[] = []
  
  // Check in-memory first
  for (const [key, state] of activePhases) {
    if (key.startsWith(`${runId}:`)) {
      phases.push(state)
    }
  }

  // Also check disk for any not in memory
  try {
    const { readdir } = await import('fs/promises')
    const files = await readdir(PHASES_DIR)
    
    for (const file of files) {
      if (file.startsWith(`${runId}-phase-`) && file.endsWith('.json')) {
        const phaseMatch = file.match(/-phase-(\d+)\.json$/)
        if (phaseMatch) {
          const phaseNumber = parseInt(phaseMatch[1], 10)
          const key = getPhaseKey(runId, phaseNumber)
          if (!activePhases.has(key)) {
            const state = await loadPhaseState(runId, phaseNumber)
            if (state) phases.push(state)
          }
        }
      }
    }
  } catch {
    // Directory may not exist yet
  }

  return phases.sort((a, b) => a.phaseNumber - b.phaseNumber)
}

/**
 * Check if phase is ready for branch collection
 */
export function isPhaseReadyForCollection(state: PhaseState): boolean {
  return (
    state.status === 'running' &&
    state.workers.every(w => w.status !== 'running')
  )
}

/**
 * Get summary of completed worker outputs for a phase
 */
export function getPhaseWorkerOutputs(state: PhaseState): string {
  return state.workers
    .filter(w => w.status === 'completed' && w.output)
    .map(w => `[${w.workerId}]: ${w.output}`)
    .join('\n\n')
}

/**
 * Get task context for workers by their branch names
 * Used by conflict resolver to understand what each worker was doing
 */
export function getWorkerTaskContexts(
  state: PhaseState,
  branchNames: string[]
): Map<string, { workerId: string; taskId: string; taskDescription?: string }> {
  const contexts = new Map<string, { workerId: string; taskId: string; taskDescription?: string }>()
  
  for (const worker of state.workers) {
    if (branchNames.includes(worker.branch)) {
      contexts.set(worker.branch, {
        workerId: worker.workerId,
        taskId: worker.taskId,
        taskDescription: worker.taskDescription,
      })
    }
  }
  
  return contexts
}

// Persistence helpers

async function savePhaseState(state: PhaseState): Promise<void> {
  try {
    await mkdir(PHASES_DIR, { recursive: true })
    const filename = `${state.runId}-phase-${state.phaseNumber}.json`
    await writeFile(join(PHASES_DIR, filename), JSON.stringify(state, null, 2))
  } catch (err) {
    console.error('[phase-collector] Failed to save phase state:', err)
  }
}

async function loadPhaseState(
  runId: string,
  phaseNumber: number
): Promise<PhaseState | null> {
  try {
    const filename = `${runId}-phase-${phaseNumber}.json`
    const data = await readFile(join(PHASES_DIR, filename), 'utf-8')
    return JSON.parse(data)
  } catch {
    return null
  }
}
