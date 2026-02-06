import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
/**
 * ReviewState - Track review workflow state for phases
 * 
 * Manages the lifecycle of code reviews:
 * - Pending reviews waiting for AI reviewer decision
 * - Fix attempts after review feedback
 * - Escalations that need human intervention
 * - Approval flow leading to merge
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'

const DATA_DIR = ORCHESTRATOR_DATA_DIR
const REVIEWS_DIR = join(DATA_DIR, 'reviews')

export type ReviewDecision = 'approve' | 'fix' | 'escalate'
export type ReviewStatus = 'pending' | 'fixing' | 'escalated' | 'approved' | 'merged'

export interface ReviewAttempt {
  attemptNumber: number
  decision: ReviewDecision
  reviewerRole?: string
  reviewerSession?: string
  fixerSession?: string
  comments?: string
  fixInstructions?: string
  escalationReason?: string
  escalationId?: string
  timestamp: string
}

export interface ReviewState {
  runId: string
  phaseNumber: number
  phaseName: string
  phaseBranch: string
  targetBranch: string
  projectDir: string
  status: ReviewStatus
  attempts: ReviewAttempt[]
  currentReviewerSession?: string
  currentFixerSession?: string
  currentReviewerRole?: string
  reviewChain?: string[]
  chainApprovals?: string[]
  startedAt: string
  completedAt?: string
  mergedAt?: string
}

// In-memory store for active reviews
const activeReviews = new Map<string, ReviewState>()

function getReviewKey(runId: string, phaseNumber: number): string {
  return `${runId}:phase-${phaseNumber}`
}

/**
 * Start tracking a new review for a phase
 */
export async function startReview(opts: {
  runId: string
  phaseNumber: number
  phaseName: string
  phaseBranch: string
  targetBranch: string
  projectDir: string
  reviewerSession?: string
}): Promise<ReviewState> {
  const { runId, phaseNumber, phaseName, phaseBranch, targetBranch, projectDir, reviewerSession } = opts
  const key = getReviewKey(runId, phaseNumber)

  // Check if review already exists
  let state = activeReviews.get(key)
  if (state) {
    // Reset for new review attempt
    state.status = 'pending'
    state.currentReviewerSession = reviewerSession
    state.currentFixerSession = undefined
  } else {
    state = {
      runId,
      phaseNumber,
      phaseName,
      phaseBranch,
      targetBranch,
      projectDir,
      status: 'pending',
      attempts: [],
      currentReviewerSession: reviewerSession,
      startedAt: new Date().toISOString(),
    }
  }

  activeReviews.set(key, state)
  await saveReviewState(state)

  console.log(`[review-state] Started review for phase ${phaseNumber} (${phaseBranch})`)
  return state
}

/**
 * Record a review decision
 */
export async function recordReviewDecision(opts: {
  runId: string
  phaseNumber: number
  decision: ReviewDecision
  reviewerSession?: string
  comments?: string
  fixInstructions?: string
  escalationReason?: string
  escalationId?: string
}): Promise<ReviewState> {
  const { runId, phaseNumber, decision, comments, fixInstructions, escalationReason, escalationId } = opts
  const key = getReviewKey(runId, phaseNumber)

  let state = activeReviews.get(key)
  if (!state) {
    state = await loadReviewState(runId, phaseNumber)
    if (!state) {
      throw new Error(`No review state found for run ${runId} phase ${phaseNumber}`)
    }
    activeReviews.set(key, state)
  }

  const attempt: ReviewAttempt = {
    attemptNumber: state.attempts.length + 1,
    decision,
    reviewerSession: state.currentReviewerSession,
    comments,
    fixInstructions,
    escalationReason,
    escalationId,
    timestamp: new Date().toISOString(),
  }

  state.attempts.push(attempt)
  state.currentReviewerSession = undefined

  switch (decision) {
    case 'approve':
      state.status = 'approved'
      break
    case 'fix':
      state.status = 'fixing'
      break
    case 'escalate':
      state.status = 'escalated'
      break
  }

  await saveReviewState(state)

  console.log(`[review-state] Phase ${phaseNumber} decision: ${decision} (attempt ${attempt.attemptNumber})`)
  return state
}

/**
 * Record that a fixer was spawned
 */
export async function recordFixerSpawned(opts: {
  runId: string
  phaseNumber: number
  fixerSession: string
}): Promise<ReviewState> {
  const { runId, phaseNumber, fixerSession } = opts
  const key = getReviewKey(runId, phaseNumber)

  let state = activeReviews.get(key)
  if (!state) {
    state = await loadReviewState(runId, phaseNumber)
    if (!state) {
      throw new Error(`No review state found for run ${runId} phase ${phaseNumber}`)
    }
    activeReviews.set(key, state)
  }

  state.currentFixerSession = fixerSession
  
  // Update the last attempt with fixer session
  if (state.attempts.length > 0) {
    state.attempts[state.attempts.length - 1].fixerSession = fixerSession
  }

  await saveReviewState(state)

  console.log(`[review-state] Fixer spawned for phase ${phaseNumber}: ${fixerSession}`)
  return state
}

/**
 * Handle fixer completion - re-trigger review
 */
export async function onFixerComplete(opts: {
  runId: string
  phaseNumber: number
  success: boolean
  summary?: string
  error?: string
}): Promise<ReviewState> {
  const { runId, phaseNumber, success } = opts
  const key = getReviewKey(runId, phaseNumber)

  let state = activeReviews.get(key)
  if (!state) {
    state = await loadReviewState(runId, phaseNumber)
    if (!state) {
      throw new Error(`No review state found for run ${runId} phase ${phaseNumber}`)
    }
    activeReviews.set(key, state)
  }

  state.currentFixerSession = undefined
  
  if (success) {
    // Ready for re-review
    state.status = 'pending'
    console.log(`[review-state] Fixer completed for phase ${phaseNumber}, ready for re-review`)
  } else {
    // Fixer failed - escalate
    state.status = 'escalated'
    console.log(`[review-state] Fixer failed for phase ${phaseNumber}, escalating`)
  }

  await saveReviewState(state)
  return state
}

/**
 * Mark review as merged
 */
export async function markMerged(opts: {
  runId: string
  phaseNumber: number
}): Promise<ReviewState> {
  const { runId, phaseNumber } = opts
  const key = getReviewKey(runId, phaseNumber)

  let state = activeReviews.get(key)
  if (!state) {
    state = await loadReviewState(runId, phaseNumber)
    if (!state) {
      throw new Error(`No review state found for run ${runId} phase ${phaseNumber}`)
    }
    activeReviews.set(key, state)
  }

  state.status = 'merged'
  state.completedAt = new Date().toISOString()
  state.mergedAt = new Date().toISOString()

  await saveReviewState(state)
  
  // Remove from active reviews
  activeReviews.delete(key)

  console.log(`[review-state] Phase ${phaseNumber} merged successfully`)
  return state
}

/**
 * Get review state for a phase
 */
export async function getReviewState(
  runId: string,
  phaseNumber: number
): Promise<ReviewState | null> {
  const key = getReviewKey(runId, phaseNumber)
  return activeReviews.get(key) || await loadReviewState(runId, phaseNumber)
}

/**
 * List all active reviews for a run
 */
export function listActiveReviews(runId: string): ReviewState[] {
  const reviews: ReviewState[] = []
  for (const [key, state] of activeReviews) {
    if (key.startsWith(`${runId}:`)) {
      reviews.push(state)
    }
  }
  return reviews.sort((a, b) => a.phaseNumber - b.phaseNumber)
}

/**
 * Check if a phase is currently under review
 */
export async function isUnderReview(runId: string, phaseNumber: number): Promise<boolean> {
  const state = await getReviewState(runId, phaseNumber)
  return state !== null && !['merged', 'escalated'].includes(state.status)
}

/**
 * Get the number of fix attempts for a phase
 */
export async function getFixAttemptCount(runId: string, phaseNumber: number): Promise<number> {
  const state = await getReviewState(runId, phaseNumber)
  if (!state) return 0
  return state.attempts.filter(a => a.decision === 'fix').length
}

// Persistence helpers

async function saveReviewState(state: ReviewState): Promise<void> {
  try {
    await mkdir(REVIEWS_DIR, { recursive: true })
    const filename = `${state.runId}-phase-${state.phaseNumber}.json`
    await writeFile(join(REVIEWS_DIR, filename), JSON.stringify(state, null, 2))
  } catch (err) {
    console.error('[review-state] Failed to save review state:', err)
  }
}

async function loadReviewState(
  runId: string,
  phaseNumber: number
): Promise<ReviewState | null> {
  try {
    const filename = `${runId}-phase-${phaseNumber}.json`
    const data = await readFile(join(REVIEWS_DIR, filename), 'utf-8')
    return JSON.parse(data)
  } catch {
    return null
  }
}
