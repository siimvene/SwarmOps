/**
 * PipelineRunner - Sequential pipeline execution orchestrator
 * 
 * Tracks active pipeline runs and manages step-by-step execution.
 * Step N+1 only starts after step N completes.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { spawnSession } from './gateway-client'
import { createWorktree, getWorktreePath, getWorkerBranch } from './worktree-manager'
import {
  logPipelineStarted,
  logTaskStarted,
  logTaskCompleted,
  logTaskFailed,
  logPipelineCompleted,
} from './ledger-writer'
import {
  createTask,
  startTask,
  completeTask,
  failTask,
  type Task,
} from './task-queue'
import {
  initRetryState,
  recordAttempt,
  canRetry,
  getRetryState,
  calculateRetryDelay,
  clearRetryState,
  type RetryState,
  DEFAULT_RETRY_POLICY,
} from './retry-handler'
import { createEscalation } from './escalation-store'

const DATA_DIR = process.env.ORCHESTRATOR_DATA_DIR || './data/orchestrator'
const RUNS_DIR = join(DATA_DIR, 'runs')

export interface PipelineStep {
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

export interface Pipeline {
  id: string
  name: string
  description?: string
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error'
  steps: PipelineStep[]
  createdAt: string
  lastRunAt?: string
  currentStep?: number
  completedSteps?: number[]
}

export interface Role {
  id: string
  name: string
  description?: string
  model?: string
  thinking?: string
  instructions?: string
}

export interface StepResult {
  stepId: string
  stepOrder: number
  status: 'completed' | 'failed' | 'skipped'
  output?: string
  error?: string
  completedAt: string
  escalationId?: string // Set when step was skipped due to max retries
}

export interface RunState {
  runId: string
  pipelineId: string
  pipelineName: string
  status: 'running' | 'completed' | 'failed'
  currentStepIndex: number
  totalSteps: number
  steps: PipelineStep[]
  stepResults: StepResult[]
  activeSessionKey?: string
  activeTaskId?: string // Current task queue entry ID
  projectContext: string
  projectDir: string
  worktreePath?: string // Git worktree path for isolated work: /tmp/swarmops-worktrees/{runId}/{workerId}/
  startedAt: string
  completedAt?: string
  stepStartTimes: Record<number, number> // stepOrder → timestamp ms
}

// In-memory store for active runs
const activeRuns = new Map<string, RunState>()

// Map sessionKey → runId for completion lookups
const sessionToRun = new Map<string, string>()

export class PipelineRunner {
  /**
   * Start a new pipeline run - spawns only the first step
   */
  static async startRun(
    pipeline: Pipeline,
    roles: Role[],
    opts: { projectContext: string; projectDir: string }
  ): Promise<{ runId: string; firstSession?: string; error?: string }> {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const sortedSteps = [...pipeline.steps].sort((a, b) => a.order - b.order)

    const runState: RunState = {
      runId,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      status: 'running',
      currentStepIndex: 0,
      totalSteps: sortedSteps.length,
      steps: sortedSteps,
      stepResults: [],
      projectContext: opts.projectContext,
      projectDir: opts.projectDir,
      startedAt: new Date().toISOString(),
      stepStartTimes: {},
    }

    // Store in memory
    activeRuns.set(runId, runState)

    // Persist to disk
    await this.saveRunState(runState)

    // Log pipeline start
    await logPipelineStarted({
      runId,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
    })

    // Update pipeline to "running" with step 1
    await this.updatePipelineStatus(pipeline.id, 'running', 1, [])

    // Spawn the first step
    const result = await this.spawnStep(runState, 0, roles)
    
    if (result.error) {
      runState.status = 'failed'
      await this.saveRunState(runState)
      return { runId, error: result.error }
    }

    runState.activeSessionKey = result.sessionKey
    runState.activeTaskId = result.taskId
    if (result.sessionKey) {
      sessionToRun.set(result.sessionKey, runId)
    }
    await this.saveRunState(runState)

    return { runId, firstSession: result.sessionKey }
  }

  /**
   * Handle step completion - advance to next step or complete the run
   */
  static async onStepComplete(
    sessionKey: string,
    result: { status: 'completed' | 'failed'; output?: string; error?: string }
  ): Promise<{ nextStep?: number; pipelineCompleted?: boolean; error?: string; retriesExhausted?: boolean; skippedStep?: number; escalationId?: string }> {
    const runId = sessionToRun.get(sessionKey)
    if (!runId) {
      // Try to find by iterating active runs
      for (const [id, state] of activeRuns) {
        if (state.activeSessionKey === sessionKey) {
          return this.advanceRun(id, result)
        }
      }
      return { error: `No run found for session ${sessionKey}` }
    }

    return this.advanceRun(runId, result)
  }

  /**
   * Handle step completion by runId and stepOrder
   */
  static async onStepCompleteByRun(
    runId: string,
    stepOrder: number,
    result: { status: 'completed' | 'failed'; output?: string; error?: string }
  ): Promise<{ nextStep?: number; pipelineCompleted?: boolean; error?: string; retriesExhausted?: boolean; skippedStep?: number; escalationId?: string }> {
    let runState = activeRuns.get(runId)
    
    if (!runState) {
      // Try loading from disk
      runState = await this.loadRunState(runId)
      if (!runState) {
        return { error: `Run ${runId} not found` }
      }
      activeRuns.set(runId, runState)
    }

    // Verify this is the expected step
    const currentStep = runState.steps[runState.currentStepIndex]
    if (currentStep.order !== stepOrder) {
      return { error: `Step order mismatch: expected ${currentStep.order}, got ${stepOrder}` }
    }

    return this.advanceRun(runId, result)
  }

  /**
   * Advance a run to the next step
   */
  private static async advanceRun(
    runId: string,
    result: { status: 'completed' | 'failed'; output?: string; error?: string }
  ): Promise<{ nextStep?: number; pipelineCompleted?: boolean; error?: string; retriesExhausted?: boolean; skippedStep?: number; escalationId?: string }> {
    let runState = activeRuns.get(runId)
    
    if (!runState) {
      // Try loading from disk
      runState = await this.loadRunState(runId)
      if (!runState) {
        return { error: `Run ${runId} not found` }
      }
      activeRuns.set(runId, runState)
    }

    const currentStep = runState.steps[runState.currentStepIndex]
    const roles = await this.loadRoles()
    const role = roles.find(r => r.id === currentStep.roleId)

    // Calculate duration
    const startTime = runState.stepStartTimes[currentStep.order]
    const duration = startTime ? Date.now() - startTime : undefined

    // Record step result
    runState.stepResults.push({
      stepId: currentStep.id,
      stepOrder: currentStep.order,
      status: result.status,
      output: result.output,
      error: result.error,
      completedAt: new Date().toISOString(),
    })

    // Update task queue entry
    if (runState.activeTaskId) {
      if (result.status === 'completed') {
        await completeTask(runState.activeTaskId, result.output)
      } else {
        await failTask(runState.activeTaskId, result.error)
      }
    }

    // Log task completion to ledger
    if (result.status === 'completed') {
      await logTaskCompleted({
        runId: runState.runId,
        pipelineId: runState.pipelineId,
        pipelineName: runState.pipelineName,
        stepOrder: currentStep.order,
        roleId: currentStep.roleId,
        roleName: role?.name,
        sessionKey: runState.activeSessionKey,
        duration,
        output: result.output,
      })
      // Clear any retry state on success
      await this.onStepSuccess(runState.runId, currentStep.order)
    } else {
      await logTaskFailed({
        runId: runState.runId,
        pipelineId: runState.pipelineId,
        pipelineName: runState.pipelineName,
        stepOrder: currentStep.order,
        roleId: currentStep.roleId,
        roleName: role?.name,
        sessionKey: runState.activeSessionKey,
        duration,
        error: result.error,
      })
    }

    // Clean up session mapping and task tracking
    if (runState.activeSessionKey) {
      sessionToRun.delete(runState.activeSessionKey)
      runState.activeSessionKey = undefined
    }
    runState.activeTaskId = undefined

    // Build completedSteps array from successful results
    const completedSteps = runState.stepResults
      .filter(r => r.status === 'completed')
      .map(r => r.stepOrder)

    // Check if step failed - apply retry logic
    if (result.status === 'failed') {
      const retryResult = await this.handleStepFailure(runState, currentStep, result.error, roles)
      
      if (retryResult.willRetry) {
        // Retry scheduled - save state and return
        await this.saveRunState(runState)
        return { 
          error: `Step ${currentStep.order} failed, retry ${retryResult.attemptNumber}/${retryResult.maxAttempts} scheduled in ${retryResult.delayMs}ms` 
        }
      }
      
      // No more retries available - SKIP AND ESCALATE
      // Create an escalation for human review
      const escalation = await createEscalation({
        runId: runState.runId,
        pipelineId: runState.pipelineId,
        pipelineName: runState.pipelineName,
        stepOrder: currentStep.order,
        roleId: currentStep.roleId,
        roleName: role?.name || currentStep.roleId,
        taskId: runState.activeTaskId,
        error: result.error || 'Unknown error after max retries',
        attemptCount: retryResult.attemptNumber,
        maxAttempts: retryResult.maxAttempts,
        projectDir: runState.projectDir,
        severity: 'high',
      })
      
      console.log(`[skip-escalate] Step ${currentStep.order} exhausted retries, created escalation ${escalation.id}`)
      
      // Update the step result to mark as skipped (not failed)
      const lastResultIdx = runState.stepResults.length - 1
      if (lastResultIdx >= 0 && runState.stepResults[lastResultIdx].stepOrder === currentStep.order) {
        runState.stepResults[lastResultIdx].status = 'skipped'
        runState.stepResults[lastResultIdx].escalationId = escalation.id
      }
      
      // Continue to next step instead of failing the pipeline
      runState.currentStepIndex++
      
      // Check if this was the last step
      if (runState.currentStepIndex >= runState.totalSteps) {
        // Pipeline completed with skipped steps
        runState.status = 'completed'
        runState.completedAt = new Date().toISOString()
        
        const pipelineStartTime = new Date(runState.startedAt).getTime()
        const pipelineDuration = Date.now() - pipelineStartTime

        await logPipelineCompleted({
          runId: runState.runId,
          pipelineId: runState.pipelineId,
          pipelineName: runState.pipelineName,
          duration: pipelineDuration,
        })

        await this.saveRunState(runState)
        
        // Include skipped steps as completed (with caveats)
        const skippedSteps = runState.stepResults.filter(r => r.status === 'skipped').map(r => r.stepOrder)
        await this.updatePipelineStatus(runState.pipelineId, 'completed', undefined, completedSteps)
        activeRuns.delete(runId)
        
        return { 
          pipelineCompleted: true,
          skippedStep: currentStep.order,
          escalationId: escalation.id,
        }
      }
      
      // Spawn next step
      const spawnResult = await this.spawnStep(runState, runState.currentStepIndex, roles)

      if (spawnResult.error) {
        runState.status = 'failed'
        runState.completedAt = new Date().toISOString()
        await this.saveRunState(runState)
        await this.updatePipelineStatus(runState.pipelineId, 'error', runState.currentStepIndex + 1, completedSteps)
        return { error: spawnResult.error, skippedStep: currentStep.order, escalationId: escalation.id }
      }

      runState.activeSessionKey = spawnResult.sessionKey
      runState.activeTaskId = spawnResult.taskId
      if (spawnResult.sessionKey) {
        sessionToRun.set(spawnResult.sessionKey, runId)
      }
      
      await this.saveRunState(runState)
      const nextStepOrder = runState.steps[runState.currentStepIndex].order
      await this.updatePipelineStatus(runState.pipelineId, 'running', nextStepOrder, completedSteps)

      console.log(`[skip-escalate] Skipped step ${currentStep.order}, continuing to step ${nextStepOrder}`)
      
      return { 
        nextStep: runState.currentStepIndex + 1,
        skippedStep: currentStep.order,
        escalationId: escalation.id,
      }
    }

    // Move to next step
    runState.currentStepIndex++

    // Check if all steps complete
    if (runState.currentStepIndex >= runState.totalSteps) {
      runState.status = 'completed'
      runState.completedAt = new Date().toISOString()
      
      // Calculate total pipeline duration
      const pipelineStartTime = new Date(runState.startedAt).getTime()
      const pipelineDuration = Date.now() - pipelineStartTime

      // Log pipeline completed
      await logPipelineCompleted({
        runId: runState.runId,
        pipelineId: runState.pipelineId,
        pipelineName: runState.pipelineName,
        duration: pipelineDuration,
      })

      await this.saveRunState(runState)
      await this.updatePipelineStatus(runState.pipelineId, 'completed', undefined, completedSteps)
      activeRuns.delete(runId)
      return { pipelineCompleted: true }
    }

    // Spawn next step (reuse roles loaded earlier)
    const spawnResult = await this.spawnStep(runState, runState.currentStepIndex, roles)

    if (spawnResult.error) {
      runState.status = 'failed'
      runState.completedAt = new Date().toISOString()
      await this.saveRunState(runState)
      await this.updatePipelineStatus(runState.pipelineId, 'error', runState.currentStepIndex + 1, completedSteps)
      return { error: spawnResult.error }
    }

    runState.activeSessionKey = spawnResult.sessionKey
    runState.activeTaskId = spawnResult.taskId
    if (spawnResult.sessionKey) {
      sessionToRun.set(spawnResult.sessionKey, runId)
    }
    
    await this.saveRunState(runState)
    // Update to show next step is now running
    const nextStepOrder = runState.steps[runState.currentStepIndex].order
    await this.updatePipelineStatus(runState.pipelineId, 'running', nextStepOrder, completedSteps)

    return { nextStep: runState.currentStepIndex + 1 }
  }

  /**
   * Handle step failure with retry logic
   */
  private static async handleStepFailure(
    runState: RunState,
    step: PipelineStep,
    error: string | undefined,
    roles: Role[]
  ): Promise<{
    willRetry: boolean
    attemptNumber: number
    maxAttempts: number
    delayMs?: number
  }> {
    // Initialize or get retry state for this step
    let retryState = await getRetryState(runState.runId, step.order)
    
    if (!retryState) {
      retryState = await initRetryState({
        runId: runState.runId,
        stepOrder: step.order,
        taskId: runState.activeTaskId,
        policy: DEFAULT_RETRY_POLICY,
      })
    }
    
    // Record this failed attempt
    retryState = await recordAttempt({
      runId: runState.runId,
      stepOrder: step.order,
      success: false,
      error: error || 'Unknown error',
    })
    
    const attemptNumber = retryState.attempts.length
    const maxAttempts = retryState.policy.maxAttempts
    
    console.log(`[retry] Step ${step.order} failed (attempt ${attemptNumber}/${maxAttempts}): ${error}`)
    
    // Check if we can retry
    if (retryState.status === 'exhausted') {
      console.log(`[retry] Step ${step.order} exhausted all ${maxAttempts} retries`)
      return {
        willRetry: false,
        attemptNumber,
        maxAttempts,
      }
    }
    
    // Calculate delay and schedule retry
    const delayMs = calculateRetryDelay(retryState)
    console.log(`[retry] Scheduling retry for step ${step.order} in ${delayMs}ms (attempt ${attemptNumber + 1}/${maxAttempts})`)
    
    // Schedule the retry after delay
    setTimeout(async () => {
      try {
        await this.executeRetry(runState.runId, step.order, roles)
      } catch (err) {
        console.error(`[retry] Failed to execute retry for step ${step.order}:`, err)
      }
    }, delayMs)
    
    return {
      willRetry: true,
      attemptNumber,
      maxAttempts,
      delayMs,
    }
  }

  /**
   * Execute a retry for a failed step
   */
  private static async executeRetry(
    runId: string,
    stepOrder: number,
    roles: Role[]
  ): Promise<void> {
    let runState = activeRuns.get(runId)
    
    if (!runState) {
      runState = await this.loadRunState(runId)
      if (!runState) {
        console.error(`[retry] Run ${runId} not found for retry`)
        return
      }
      activeRuns.set(runId, runState)
    }
    
    // Find the step by order
    const stepIndex = runState.steps.findIndex(s => s.order === stepOrder)
    if (stepIndex === -1) {
      console.error(`[retry] Step ${stepOrder} not found in run ${runId}`)
      return
    }
    
    console.log(`[retry] Executing retry for step ${stepOrder} of run ${runId}`)
    
    // Remove the previous failed result for this step so we can try again
    runState.stepResults = runState.stepResults.filter(r => r.stepOrder !== stepOrder)
    
    // Spawn the step again
    const result = await this.spawnStep(runState, stepIndex, roles)
    
    if (result.error) {
      console.error(`[retry] Spawn failed for step ${stepOrder}:`, result.error)
      // Record this as another failed attempt
      const retryState = await recordAttempt({
        runId,
        stepOrder,
        success: false,
        error: result.error,
      })
      
      // Check if we should retry again
      if (retryState.status !== 'exhausted') {
        const delayMs = calculateRetryDelay(retryState)
        console.log(`[retry] Spawn failed, scheduling another retry in ${delayMs}ms`)
        setTimeout(async () => {
          try {
            await this.executeRetry(runId, stepOrder, roles)
          } catch (err) {
            console.error(`[retry] Retry execution failed:`, err)
          }
        }, delayMs)
      } else {
        // SKIP AND ESCALATE on spawn exhaustion
        console.log(`[retry] Step ${stepOrder} exhausted all retries after spawn failures, skipping with escalation`)
        
        const step = runState.steps[stepIndex]
        const role = roles.find(r => r.id === step.roleId)
        
        const escalation = await createEscalation({
          runId: runState.runId,
          pipelineId: runState.pipelineId,
          pipelineName: runState.pipelineName,
          stepOrder: step.order,
          roleId: step.roleId,
          roleName: role?.name || step.roleId,
          error: result.error || 'Spawn failures exhausted retries',
          attemptCount: retryState.attempts.length,
          maxAttempts: retryState.policy.maxAttempts,
          projectDir: runState.projectDir,
          severity: 'high',
        })
        
        // Add skipped result
        runState.stepResults.push({
          stepId: step.id,
          stepOrder: step.order,
          status: 'skipped',
          error: result.error,
          completedAt: new Date().toISOString(),
          escalationId: escalation.id,
        })
        
        // Continue to next step
        runState.currentStepIndex++
        const completedSteps = runState.stepResults.filter(r => r.status === 'completed').map(r => r.stepOrder)
        
        if (runState.currentStepIndex >= runState.totalSteps) {
          runState.status = 'completed'
          runState.completedAt = new Date().toISOString()
          await this.saveRunState(runState)
          await this.updatePipelineStatus(runState.pipelineId, 'completed', undefined, completedSteps)
          activeRuns.delete(runId)
          console.log(`[skip-escalate] Pipeline completed after skipping step ${step.order}`)
        } else {
          // Spawn next step
          const spawnResult = await this.spawnStep(runState, runState.currentStepIndex, roles)
          if (spawnResult.error) {
            runState.status = 'failed'
            runState.completedAt = new Date().toISOString()
            await this.saveRunState(runState)
            await this.updatePipelineStatus(runState.pipelineId, 'error', runState.currentStepIndex + 1, completedSteps)
          } else {
            runState.activeSessionKey = spawnResult.sessionKey
            runState.activeTaskId = spawnResult.taskId
            if (spawnResult.sessionKey) {
              sessionToRun.set(spawnResult.sessionKey, runId)
            }
            await this.saveRunState(runState)
            const nextStepOrder = runState.steps[runState.currentStepIndex].order
            await this.updatePipelineStatus(runState.pipelineId, 'running', nextStepOrder, completedSteps)
            console.log(`[skip-escalate] Skipped step ${step.order}, continuing to step ${nextStepOrder}`)
          }
        }
      }
      return
    }
    
    // Update run state with new session
    runState.activeSessionKey = result.sessionKey
    runState.activeTaskId = result.taskId
    if (result.sessionKey) {
      sessionToRun.set(result.sessionKey, runId)
    }
    
    await this.saveRunState(runState)
    console.log(`[retry] Step ${stepOrder} retry spawned successfully, session: ${result.sessionKey}`)
  }

  /**
   * Called when a retried step completes successfully - clear retry state
   */
  static async onStepSuccess(runId: string, stepOrder: number): Promise<void> {
    await clearRetryState(runId, stepOrder)
    console.log(`[retry] Cleared retry state for step ${stepOrder} of run ${runId} after success`)
  }

  /**
   * Spawn a specific step
   */
  private static async spawnStep(
    runState: RunState,
    stepIndex: number,
    roles: Role[]
  ): Promise<{ sessionKey?: string; taskId?: string; error?: string }> {
    const step = runState.steps[stepIndex]
    const roleMap = new Map(roles.map(r => [r.id, r]))
    const role = roleMap.get(step.roleId)

    // Track step start time
    runState.stepStartTimes[step.order] = Date.now()

    // Generate worker ID for this step
    const workerId = `step-${step.order}`

    // Create worktree for isolated work
    let worktreePath = runState.projectDir // fallback to original dir
    let workerBranch: string | undefined
    
    const worktreeResult = await createWorktree({
      repoDir: runState.projectDir,
      runId: runState.runId,
      workerId,
      baseBranch: 'main',
    })

    if (worktreeResult.ok && worktreeResult.worktree) {
      worktreePath = worktreeResult.worktree.path
      workerBranch = worktreeResult.worktree.branch
      runState.worktreePath = worktreePath
      console.log(`[worktree] Created worktree for step ${step.order}: ${worktreePath} (branch: ${workerBranch})`)
    } else {
      console.warn(`[worktree] Failed to create worktree for step ${step.order}: ${worktreeResult.error}`)
      console.warn(`[worktree] Falling back to working directly in ${runState.projectDir}`)
    }

    // Create task entry in work queue (pending)
    const task = await createTask({
      pipelineId: runState.pipelineId,
      pipelineName: runState.pipelineName,
      runId: runState.runId,
      stepOrder: step.order,
      roleId: step.roleId,
      roleName: role?.name || step.roleId,
    })

    // Build prompt with previous step context
    const previousOutputs = runState.stepResults
      .filter(r => r.status === 'completed' && r.output)
      .map(r => `Step ${r.stepOrder} output:\n${r.output}`)
      .join('\n\n')

    const taskPrompt = buildTaskPrompt({
      runId: runState.runId,
      pipelineName: runState.pipelineName,
      stepOrder: step.order,
      totalSteps: runState.totalSteps,
      roleName: role?.name || step.roleId,
      roleInstructions: role?.instructions,
      projectContext: runState.projectContext,
      projectDir: runState.projectDir,
      worktreePath,
      workerBranch,
      previousOutputs,
    })

    const label = `builder:${runState.pipelineName}:step-${step.order}`

    try {
      const result = await spawnSession({
        task: taskPrompt,
        label,
        model: role?.model,
        thinking: role?.thinking,
        cleanup: 'keep',
      })

      if (result.ok && result.result) {
        const sessionKey = result.result.childSessionKey

        // Update task to running status with sessionKey
        await startTask(task.id, sessionKey)

        // Log task started
        await logTaskStarted({
          runId: runState.runId,
          pipelineId: runState.pipelineId,
          pipelineName: runState.pipelineName,
          stepOrder: step.order,
          roleId: step.roleId,
          roleName: role?.name,
          sessionKey,
        })

        return { sessionKey, taskId: task.id }
      } else {
        // Mark task as failed since spawn failed
        await failTask(task.id, result.error?.message || 'Spawn failed')
        return { error: result.error?.message || 'Spawn failed' }
      }
    } catch (err: any) {
      // Mark task as failed on exception
      await failTask(task.id, err.message || 'Spawn exception')
      return { error: err.message || 'Spawn exception' }
    }
  }

  /**
   * Get run state by ID
   */
  static async getRunState(runId: string): Promise<RunState | null> {
    return activeRuns.get(runId) || await this.loadRunState(runId)
  }

  /**
   * Get run by session key
   */
  static getRunBySession(sessionKey: string): RunState | undefined {
    const runId = sessionToRun.get(sessionKey)
    if (runId) {
      return activeRuns.get(runId)
    }
    // Fallback search
    for (const state of activeRuns.values()) {
      if (state.activeSessionKey === sessionKey) {
        return state
      }
    }
    return undefined
  }

  /**
   * List active runs
   */
  static getActiveRuns(): RunState[] {
    return Array.from(activeRuns.values())
  }

  // Persistence helpers

  private static async saveRunState(state: RunState): Promise<void> {
    try {
      await mkdir(RUNS_DIR, { recursive: true })
      await writeFile(
        join(RUNS_DIR, `${state.runId}.json`),
        JSON.stringify(state, null, 2)
      )
    } catch (err) {
      console.error('Failed to save run state:', err)
    }
  }

  private static async loadRunState(runId: string): Promise<RunState | null> {
    try {
      const data = await readFile(join(RUNS_DIR, `${runId}.json`), 'utf-8')
      return JSON.parse(data)
    } catch {
      return null
    }
  }

  private static async loadRoles(): Promise<Role[]> {
    try {
      const data = await readFile(join(DATA_DIR, 'roles.json'), 'utf-8')
      return JSON.parse(data)
    } catch {
      return []
    }
  }

  private static async updatePipelineStatus(
    pipelineId: string,
    status: Pipeline['status'],
    currentStep?: number,
    completedSteps?: number[]
  ): Promise<void> {
    try {
      const pipelinesPath = join(DATA_DIR, 'pipelines.json')
      const data = await readFile(pipelinesPath, 'utf-8')
      const pipelines: Pipeline[] = JSON.parse(data)
      
      const idx = pipelines.findIndex(p => p.id === pipelineId)
      if (idx !== -1) {
        pipelines[idx].status = status
        pipelines[idx].lastRunAt = new Date().toISOString()
        
        if (status === 'running') {
          // Running: show current step and completed steps
          pipelines[idx].currentStep = currentStep
          pipelines[idx].completedSteps = completedSteps || []
        } else if (status === 'completed') {
          // Completed: clear current step, keep completed steps
          pipelines[idx].currentStep = undefined
          pipelines[idx].completedSteps = completedSteps || []
        } else if (status === 'error') {
          // Error: keep current step (where it failed), keep completed steps
          pipelines[idx].currentStep = currentStep
          pipelines[idx].completedSteps = completedSteps || []
        } else {
          // Idle or other: clear tracking fields
          pipelines[idx].currentStep = undefined
          pipelines[idx].completedSteps = undefined
        }
        
        await writeFile(pipelinesPath, JSON.stringify(pipelines, null, 2))
      }
    } catch (err) {
      console.error('Failed to update pipeline status:', err)
    }
  }
}

function buildTaskPrompt(opts: {
  runId: string
  pipelineName: string
  stepOrder: number
  totalSteps: number
  roleName: string
  roleInstructions?: string
  projectContext: string
  projectDir: string
  worktreePath?: string
  workerBranch?: string
  previousOutputs?: string
}): string {
  const lines = [
    `[SWARMOPS BUILDER] Pipeline: ${opts.pipelineName}`,
    `Step ${opts.stepOrder} of ${opts.totalSteps} | Role: ${opts.roleName}`,
    `Run ID: ${opts.runId}`,
    '',
  ]

  if (opts.roleInstructions) {
    lines.push('## Your Role')
    lines.push(opts.roleInstructions)
    lines.push('')
  }

  lines.push('## Context')
  lines.push(opts.projectContext)

  // Use worktree path as working directory if available
  const workDir = opts.worktreePath || opts.projectDir
  lines.push('')
  
  if (opts.worktreePath && opts.workerBranch) {
    lines.push('## Working Environment')
    lines.push('')
    lines.push(`You are working in an **isolated git worktree** for parallel development:`)
    lines.push('')
    lines.push(`- **Worktree Path:** \`${opts.worktreePath}\``)
    lines.push(`- **Branch:** \`${opts.workerBranch}\``)
    lines.push(`- **Original Project:** \`${opts.projectDir}\``)
    lines.push('')
    lines.push('> ⚠️ **IMPORTANT:** All your file operations must use the worktree path above, NOT the original project path.')
    lines.push('> The worktree is your isolated workspace. Changes here won\'t affect other workers.')
  } else {
    lines.push(`**Working directory:** ${workDir}`)
    lines.push('')
    lines.push('> Note: Working directly in project directory (no worktree isolation).')
  }

  if (opts.previousOutputs) {
    lines.push('')
    lines.push('## Previous Steps Output')
    lines.push(opts.previousOutputs)
  }

  lines.push('')
  lines.push('## Instructions')
  lines.push('')
  lines.push('1. **Read relevant files** to understand current state')
  lines.push('2. **Complete your assigned work**')
  
  if (opts.worktreePath && opts.workerBranch) {
    lines.push('3. **Commit your changes** with a descriptive message:')
    lines.push('   ```bash')
    lines.push(`   cd ${opts.worktreePath}`)
    lines.push('   git add -A')
    lines.push(`   git commit -m "step-${opts.stepOrder}: [describe what you did]"`)
    lines.push('   ```')
    lines.push('4. **Update progress files** if they exist (mark your task complete)')
    lines.push('5. **Report completion** via the webhook below')
    lines.push('')
    lines.push('### Git Commit Guidelines')
    lines.push('- Stage all changes with `git add -A`')
    lines.push('- Use descriptive commit messages')
    lines.push(`- Prefix with step number: \`step-${opts.stepOrder}: ...\``)
    lines.push('- Commit before calling the completion webhook')
  } else {
    lines.push('3. **Update progress files** if they exist')
    lines.push('4. **Summarize** what you did when finished')
  }

  lines.push('')
  lines.push('## IMPORTANT: Report Completion')
  lines.push('')
  lines.push('When you finish your task, you **MUST** call the completion webhook:')
  lines.push('')
  lines.push('```bash')
  lines.push(`curl -X POST http://localhost:3939/api/orchestrator/worker-complete \\`)
  lines.push(`  -H "Content-Type: application/json" \\`)
  lines.push(`  -d '{"runId": "${opts.runId}", "stepOrder": ${opts.stepOrder}, "status": "completed", "output": "YOUR_SUMMARY_HERE"}'`)
  lines.push('```')
  lines.push('')
  lines.push('- Replace `YOUR_SUMMARY_HERE` with a brief summary of what you accomplished.')
  lines.push('- If you encounter an error, use `"status": "failed"` and include `"error": "description"`.')
  lines.push('')
  lines.push('---')
  lines.push(`Remember: Your working directory is \`${workDir}\` — use this path for all file operations.`)

  return lines.join('\n')
}
