import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
/**
 * ReviewHandler - Manages review result processing and fix cycles
 * 
 * Handles:
 * - Approving reviews and merging to main
 * - Spawning fixer agents for issues found
 * - Escalating complex issues for human review
 * - Tracking fix attempts for re-review cycles
 */

import { exec as execCallback } from 'child_process'
import { promisify } from 'util'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { spawnFixer, type ReviewResult } from './phase-reviewer'
import { getPhaseState, type PhaseState } from './phase-collector'
import { createEscalation, type Escalation } from './escalation-store'
import { checkoutBranch, mergeBranch, branchExists, getCurrentBranch } from './conflict-resolver'

const exec = promisify(execCallback)

const DATA_DIR = ORCHESTRATOR_DATA_DIR
const FIX_CYCLES_PATH = join(DATA_DIR, 'fix-cycles.json')

export interface FixCycle {
  id: string
  runId: string
  phaseNumber: number
  phaseBranch: string
  repoDir: string
  
  // Tracking
  reviewCount: number
  fixCount: number
  maxFixAttempts: number
  
  // Current state
  status: 'pending-fix' | 'fixing' | 'pending-review' | 'approved' | 'escalated'
  currentFixerSession?: string
  lastReviewComments?: string
  lastFixInstructions?: string
  
  // Timestamps
  createdAt: string
  updatedAt: string
}

/**
 * Handle review approval - merge phase branch to main
 */
export async function handleApproval(opts: {
  runId: string
  phaseNumber: number
  comments?: string
}): Promise<{
  success: boolean
  merged?: boolean
  error?: string
  message?: string
}> {
  const { runId, phaseNumber, comments } = opts
  
  console.log(`[review-handler] Processing approval for phase ${phaseNumber}`)
  
  const phaseState = await getPhaseState(runId, phaseNumber)
  if (!phaseState) {
    return { success: false, error: `Phase ${phaseNumber} not found` }
  }
  
  if (!phaseState.phaseBranch) {
    return { success: false, error: 'No phase branch to merge' }
  }
  
  // Attempt merge to main
  const mergeResult = await mergeToMain({
    repoDir: phaseState.repoDir,
    phaseBranch: phaseState.phaseBranch,
    phaseNumber,
    runId,
  })
  
  if (mergeResult.success) {
    // Clean up fix cycle if one exists
    await clearFixCycle(runId, phaseNumber)
    
    console.log(`[review-handler] Phase ${phaseNumber} merged to main successfully`)
    return {
      success: true,
      merged: true,
      message: `Phase ${phaseNumber} merged to main`,
    }
  }
  
  return {
    success: false,
    merged: false,
    error: mergeResult.error,
  }
}

/**
 * Handle fix request - spawn fixer agent
 */
export async function handleFixRequest(opts: {
  runId: string
  phaseNumber: number
  fixInstructions: string
  reviewComments?: string
}): Promise<{
  success: boolean
  fixerSession?: string
  escalated?: boolean
  escalationId?: string
  error?: string
  message?: string
}> {
  const { runId, phaseNumber, fixInstructions, reviewComments } = opts
  
  console.log(`[review-handler] Processing fix request for phase ${phaseNumber}`)
  
  const phaseState = await getPhaseState(runId, phaseNumber)
  if (!phaseState) {
    return { success: false, error: `Phase ${phaseNumber} not found` }
  }
  
  // Get or create fix cycle
  let fixCycle = await getFixCycle(runId, phaseNumber)
  
  if (!fixCycle) {
    fixCycle = await createFixCycle({
      runId,
      phaseNumber,
      phaseBranch: phaseState.phaseBranch || `swarmops/${runId}/phase-${phaseNumber}`,
      repoDir: phaseState.repoDir,
    })
  }
  
  // Check if we've exceeded max fix attempts
  if (fixCycle.fixCount >= fixCycle.maxFixAttempts) {
    console.log(`[review-handler] Max fix attempts (${fixCycle.maxFixAttempts}) reached, escalating`)
    
    const escalation = await createEscalation({
      runId,
      pipelineId: runId,
      pipelineName: `phase-${phaseNumber}`,
      stepOrder: phaseNumber,
      roleId: 'fixer',
      roleName: 'AI Fixer',
      error: `Max fix attempts (${fixCycle.maxFixAttempts}) reached. Last issues: ${fixInstructions}`,
      attemptCount: fixCycle.fixCount,
      maxAttempts: fixCycle.maxFixAttempts,
      projectDir: phaseState.repoDir,
      severity: 'high',
    })
    
    fixCycle.status = 'escalated'
    await saveFixCycle(fixCycle)
    
    return {
      success: true,
      escalated: true,
      escalationId: escalation.id,
      message: 'Max fix attempts reached, escalated for human review',
    }
  }
  
  // Spawn fixer agent
  const fixerResult = await spawnFixer({
    runId,
    phaseName: `phase-${phaseNumber}`,
    phaseNumber,
    projectDir: phaseState.repoDir,
    phaseBranch: fixCycle.phaseBranch,
    fixInstructions,
    reviewComments,
  })
  
  if (!fixerResult.ok) {
    return {
      success: false,
      error: fixerResult.error || 'Failed to spawn fixer',
    }
  }
  
  // Update fix cycle
  fixCycle.fixCount++
  fixCycle.status = 'fixing'
  fixCycle.currentFixerSession = fixerResult.sessionKey
  fixCycle.lastReviewComments = reviewComments
  fixCycle.lastFixInstructions = fixInstructions
  fixCycle.updatedAt = new Date().toISOString()
  await saveFixCycle(fixCycle)
  
  console.log(`[review-handler] Fixer spawned: ${fixerResult.sessionKey} (attempt ${fixCycle.fixCount}/${fixCycle.maxFixAttempts})`)
  
  return {
    success: true,
    fixerSession: fixerResult.sessionKey,
    message: `Fixer spawned (attempt ${fixCycle.fixCount}/${fixCycle.maxFixAttempts})`,
  }
}

/**
 * Handle escalation - create escalation for human review
 */
export async function handleEscalation(opts: {
  runId: string
  phaseNumber: number
  escalationReason: string
  reviewComments?: string
}): Promise<{
  success: boolean
  escalationId?: string
  error?: string
  message?: string
}> {
  const { runId, phaseNumber, escalationReason, reviewComments } = opts
  
  console.log(`[review-handler] Processing escalation for phase ${phaseNumber}`)
  
  const phaseState = await getPhaseState(runId, phaseNumber)
  
  const escalation = await createEscalation({
    runId,
    pipelineId: runId,
    pipelineName: `phase-${phaseNumber}`,
    stepOrder: phaseNumber,
    roleId: 'reviewer',
    roleName: 'AI Reviewer',
    error: `Escalated: ${escalationReason}${reviewComments ? `\n\nComments: ${reviewComments}` : ''}`,
    attemptCount: 1,
    maxAttempts: 1,
    projectDir: phaseState?.repoDir || '',
    severity: 'medium',
  })
  
  // Update fix cycle if exists
  const fixCycle = await getFixCycle(runId, phaseNumber)
  if (fixCycle) {
    fixCycle.status = 'escalated'
    fixCycle.updatedAt = new Date().toISOString()
    await saveFixCycle(fixCycle)
  }
  
  console.log(`[review-handler] Escalation created: ${escalation.id}`)
  
  return {
    success: true,
    escalationId: escalation.id,
    message: 'Review escalated for human decision',
  }
}

/**
 * Handle fixer completion - trigger re-review
 */
export async function handleFixComplete(opts: {
  runId: string
  phaseNumber: number
  status: 'completed' | 'failed'
  summary?: string
  error?: string
}): Promise<{
  success: boolean
  reviewTriggered?: boolean
  reviewerSession?: string
  escalated?: boolean
  escalationId?: string
  error?: string
  message?: string
}> {
  const { runId, phaseNumber, status, summary, error } = opts
  
  console.log(`[review-handler] Processing fix completion for phase ${phaseNumber}: ${status}`)
  
  const fixCycle = await getFixCycle(runId, phaseNumber)
  if (!fixCycle) {
    return { success: false, error: 'No fix cycle found' }
  }
  
  if (status === 'failed') {
    // Check if we should escalate or allow retry
    if (fixCycle.fixCount >= fixCycle.maxFixAttempts) {
      console.log(`[review-handler] Fixer failed and max attempts reached, escalating`)
      
      const phaseState = await getPhaseState(runId, phaseNumber)
      const escalation = await createEscalation({
        runId,
        pipelineId: runId,
        pipelineName: `phase-${phaseNumber}`,
        stepOrder: phaseNumber,
        roleId: 'fixer',
        roleName: 'AI Fixer',
        error: `Fixer failed after ${fixCycle.fixCount} attempts: ${error || 'Unknown error'}`,
        attemptCount: fixCycle.fixCount,
        maxAttempts: fixCycle.maxFixAttempts,
        projectDir: phaseState?.repoDir || '',
        severity: 'high',
      })
      
      fixCycle.status = 'escalated'
      fixCycle.updatedAt = new Date().toISOString()
      await saveFixCycle(fixCycle)
      
      return {
        success: true,
        escalated: true,
        escalationId: escalation.id,
        message: 'Fixer failed and max attempts reached, escalated',
      }
    }
    
    // Allow retry - stay in pending-fix state
    fixCycle.status = 'pending-fix'
    fixCycle.currentFixerSession = undefined
    fixCycle.updatedAt = new Date().toISOString()
    await saveFixCycle(fixCycle)
    
    return {
      success: true,
      message: `Fixer failed. ${fixCycle.maxFixAttempts - fixCycle.fixCount} attempts remaining.`,
    }
  }
  
  // Fixer completed successfully - trigger re-review
  fixCycle.status = 'pending-review'
  fixCycle.reviewCount++
  fixCycle.currentFixerSession = undefined
  fixCycle.updatedAt = new Date().toISOString()
  await saveFixCycle(fixCycle)
  
  // Import and trigger review
  const { triggerPhaseReview } = await import('./phase-merger')
  const reviewResult = await triggerPhaseReview({
    runId,
    phaseNumber,
    phaseName: `phase-${phaseNumber}`,
  })
  
  if (reviewResult.ok && reviewResult.sessionKey) {
    console.log(`[review-handler] Re-review triggered: ${reviewResult.sessionKey}`)
    return {
      success: true,
      reviewTriggered: true,
      reviewerSession: reviewResult.sessionKey,
      message: 'Fixes applied, re-review triggered',
    }
  }
  
  console.log(`[review-handler] Failed to trigger re-review: ${reviewResult.error}`)
  return {
    success: true,
    reviewTriggered: false,
    error: reviewResult.error,
    message: 'Fixes applied but failed to trigger re-review',
  }
}

/**
 * Merge a phase branch to main
 */
async function mergeToMain(opts: {
  repoDir: string
  phaseBranch: string
  phaseNumber: number
  runId: string
}): Promise<{ success: boolean; error?: string }> {
  const { repoDir, phaseBranch, phaseNumber, runId } = opts
  
  console.log(`[review-handler] Merging ${phaseBranch} to main`)
  
  // Store current branch to restore later
  const originalBranch = await getCurrentBranch(repoDir)
  
  try {
    // Check if phase branch exists
    const phaseExists = await branchExists(repoDir, phaseBranch)
    if (!phaseExists) {
      return { success: false, error: `Phase branch ${phaseBranch} does not exist` }
    }
    
    // Checkout main
    const checkoutResult = await checkoutBranch(repoDir, 'main')
    if (!checkoutResult.success) {
      return { success: false, error: `Failed to checkout main: ${checkoutResult.error}` }
    }
    
    // Merge phase branch
    const mergeResult = await mergeBranch(repoDir, phaseBranch, {
      message: `Merge phase ${phaseNumber} (run: ${runId}) - Approved by AI review`,
    })
    
    if (!mergeResult.success) {
      // Abort merge and restore
      await exec('git merge --abort', { cwd: repoDir }).catch(() => {})
      await checkoutBranch(repoDir, originalBranch)
      
      if (mergeResult.conflicted) {
        return { success: false, error: `Merge conflict detected. Conflicted files: ${mergeResult.conflictFiles?.join(', ')}` }
      }
      return { success: false, error: mergeResult.error || 'Merge failed' }
    }
    
    console.log(`[review-handler] Successfully merged ${phaseBranch} to main`)
    return { success: true }
    
  } catch (err: any) {
    // Try to restore original state
    await exec('git merge --abort', { cwd: repoDir }).catch(() => {})
    await checkoutBranch(repoDir, originalBranch).catch(() => {})
    
    return { success: false, error: err.message || 'Exception during merge' }
  }
}

// Fix cycle persistence

async function readFixCycles(): Promise<FixCycle[]> {
  try {
    const content = await readFile(FIX_CYCLES_PATH, 'utf-8')
    return JSON.parse(content)
  } catch {
    return []
  }
}

async function writeFixCycles(cycles: FixCycle[]): Promise<void> {
  await mkdir(dirname(FIX_CYCLES_PATH), { recursive: true })
  await writeFile(FIX_CYCLES_PATH, JSON.stringify(cycles, null, 2))
}

async function createFixCycle(opts: {
  runId: string
  phaseNumber: number
  phaseBranch: string
  repoDir: string
}): Promise<FixCycle> {
  const cycles = await readFixCycles()
  
  const cycle: FixCycle = {
    id: `fix-${opts.runId}-phase-${opts.phaseNumber}`,
    runId: opts.runId,
    phaseNumber: opts.phaseNumber,
    phaseBranch: opts.phaseBranch,
    repoDir: opts.repoDir,
    reviewCount: 1, // First review already happened
    fixCount: 0,
    maxFixAttempts: 3,
    status: 'pending-fix',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  
  cycles.push(cycle)
  await writeFixCycles(cycles)
  
  return cycle
}

async function saveFixCycle(cycle: FixCycle): Promise<void> {
  const cycles = await readFixCycles()
  const idx = cycles.findIndex(c => c.id === cycle.id)
  
  if (idx >= 0) {
    cycles[idx] = cycle
  } else {
    cycles.push(cycle)
  }
  
  await writeFixCycles(cycles)
}

export async function getFixCycle(runId: string, phaseNumber: number): Promise<FixCycle | undefined> {
  const cycles = await readFixCycles()
  return cycles.find(c => c.runId === runId && c.phaseNumber === phaseNumber)
}

async function clearFixCycle(runId: string, phaseNumber: number): Promise<void> {
  const cycles = await readFixCycles()
  const filtered = cycles.filter(c => !(c.runId === runId && c.phaseNumber === phaseNumber))
  await writeFixCycles(filtered)
}

/**
 * List all active fix cycles
 */
export async function listActiveFixCycles(): Promise<FixCycle[]> {
  const cycles = await readFixCycles()
  return cycles.filter(c => c.status !== 'approved' && c.status !== 'escalated')
}

/**
 * Get fix cycle stats
 */
export async function getFixCycleStats(): Promise<{
  total: number
  pendingFix: number
  fixing: number
  pendingReview: number
  approved: number
  escalated: number
}> {
  const cycles = await readFixCycles()
  
  return {
    total: cycles.length,
    pendingFix: cycles.filter(c => c.status === 'pending-fix').length,
    fixing: cycles.filter(c => c.status === 'fixing').length,
    pendingReview: cycles.filter(c => c.status === 'pending-review').length,
    approved: cycles.filter(c => c.status === 'approved').length,
    escalated: cycles.filter(c => c.status === 'escalated').length,
  }
}
