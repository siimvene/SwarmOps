import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
/**
 * RetryHandler - Retry policy and attempt tracking for pipeline steps
 * 
 * Manages retry logic with configurable policies, exponential backoff,
 * and persistent attempt tracking.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'

const RETRY_STATE_PATH = join(ORCHESTRATOR_DATA_DIR, 'retry-state.json')

export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  backoffMultiplier: number
  retryableErrors?: string[]
}

export interface RetryAttempt {
  attempt: number
  timestamp: string
  error?: string
  durationMs?: number
}

export interface RetryState {
  runId: string
  stepOrder: number
  taskId?: string
  attempts: RetryAttempt[]
  policy: RetryPolicy
  status: 'pending' | 'retrying' | 'exhausted' | 'succeeded'
  nextRetryAt?: string
  createdAt: string
  updatedAt: string
}

// Default retry policy
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 5000,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
}

// In-memory cache for active retry states
const retryStates = new Map<string, RetryState>()

/**
 * Generate a unique key for a step's retry state
 */
function makeRetryKey(runId: string, stepOrder: number): string {
  return `${runId}:step-${stepOrder}`
}

/**
 * Read all retry states from disk
 */
export async function readRetryStates(): Promise<RetryState[]> {
  try {
    const content = await readFile(RETRY_STATE_PATH, 'utf-8')
    return JSON.parse(content)
  } catch {
    return []
  }
}

/**
 * Write retry states to disk
 */
async function writeRetryStates(states: RetryState[]): Promise<void> {
  await mkdir(dirname(RETRY_STATE_PATH), { recursive: true })
  await writeFile(RETRY_STATE_PATH, JSON.stringify(states, null, 2))
}

/**
 * Initialize retry tracking for a step
 */
export async function initRetryState(params: {
  runId: string
  stepOrder: number
  taskId?: string
  policy?: Partial<RetryPolicy>
}): Promise<RetryState> {
  const key = makeRetryKey(params.runId, params.stepOrder)
  const now = new Date().toISOString()
  
  const state: RetryState = {
    runId: params.runId,
    stepOrder: params.stepOrder,
    taskId: params.taskId,
    attempts: [],
    policy: { ...DEFAULT_RETRY_POLICY, ...params.policy },
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }
  
  retryStates.set(key, state)
  await persistRetryState(state)
  
  return state
}

/**
 * Record an attempt (success or failure)
 */
export async function recordAttempt(params: {
  runId: string
  stepOrder: number
  success: boolean
  error?: string
  durationMs?: number
}): Promise<RetryState> {
  const key = makeRetryKey(params.runId, params.stepOrder)
  let state = retryStates.get(key)
  
  if (!state) {
    state = await loadRetryState(params.runId, params.stepOrder)
    if (!state) {
      // Auto-initialize if not found
      state = await initRetryState({
        runId: params.runId,
        stepOrder: params.stepOrder,
      })
    }
  }
  
  const attempt: RetryAttempt = {
    attempt: state.attempts.length + 1,
    timestamp: new Date().toISOString(),
    error: params.error,
    durationMs: params.durationMs,
  }
  
  state.attempts.push(attempt)
  state.updatedAt = new Date().toISOString()
  
  if (params.success) {
    state.status = 'succeeded'
    state.nextRetryAt = undefined
  } else if (state.attempts.length >= state.policy.maxAttempts) {
    state.status = 'exhausted'
    state.nextRetryAt = undefined
  } else {
    state.status = 'retrying'
    state.nextRetryAt = calculateNextRetryTime(state)
  }
  
  retryStates.set(key, state)
  await persistRetryState(state)
  
  return state
}

/**
 * Check if a step can be retried
 */
export async function canRetry(runId: string, stepOrder: number): Promise<boolean> {
  const key = makeRetryKey(runId, stepOrder)
  let state = retryStates.get(key)
  
  if (!state) {
    state = await loadRetryState(runId, stepOrder)
  }
  
  if (!state) {
    return true // No state means first attempt
  }
  
  return state.attempts.length < state.policy.maxAttempts
}

/**
 * Get current attempt number (1-indexed, 0 if no attempts yet)
 */
export async function getCurrentAttempt(runId: string, stepOrder: number): Promise<number> {
  const key = makeRetryKey(runId, stepOrder)
  let state = retryStates.get(key)
  
  if (!state) {
    state = await loadRetryState(runId, stepOrder)
  }
  
  return state?.attempts.length || 0
}

/**
 * Get retry state for a step
 */
export async function getRetryState(runId: string, stepOrder: number): Promise<RetryState | null> {
  const key = makeRetryKey(runId, stepOrder)
  let state = retryStates.get(key)
  
  if (!state) {
    state = await loadRetryState(runId, stepOrder) || undefined
  }
  
  return state || null
}

/**
 * Get all retry states for a run
 */
export async function getRunRetryStates(runId: string): Promise<RetryState[]> {
  const allStates = await readRetryStates()
  return allStates.filter(s => s.runId === runId)
}

/**
 * Calculate delay before next retry using exponential backoff
 */
export function calculateRetryDelay(state: RetryState): number {
  const attemptNumber = state.attempts.length
  const { baseDelayMs, maxDelayMs, backoffMultiplier } = state.policy
  
  // Exponential backoff: baseDelay * (multiplier ^ attemptNumber)
  const delay = baseDelayMs * Math.pow(backoffMultiplier, attemptNumber)
  
  // Add jitter (±10%)
  const jitter = delay * 0.1 * (Math.random() * 2 - 1)
  
  return Math.min(Math.floor(delay + jitter), maxDelayMs)
}

/**
 * Calculate the next retry timestamp
 */
function calculateNextRetryTime(state: RetryState): string {
  const delayMs = calculateRetryDelay(state)
  return new Date(Date.now() + delayMs).toISOString()
}

/**
 * Check if a retry should happen now (based on nextRetryAt)
 */
export function shouldRetryNow(state: RetryState): boolean {
  if (state.status !== 'retrying' || !state.nextRetryAt) {
    return false
  }
  return new Date(state.nextRetryAt).getTime() <= Date.now()
}

/**
 * Get time until next retry in milliseconds
 */
export function getTimeUntilRetry(state: RetryState): number {
  if (!state.nextRetryAt) {
    return 0
  }
  return Math.max(0, new Date(state.nextRetryAt).getTime() - Date.now())
}

/**
 * Clear retry state for a step (e.g., on successful completion)
 */
export async function clearRetryState(runId: string, stepOrder: number): Promise<void> {
  const key = makeRetryKey(runId, stepOrder)
  retryStates.delete(key)
  
  const allStates = await readRetryStates()
  const filtered = allStates.filter(
    s => !(s.runId === runId && s.stepOrder === stepOrder)
  )
  await writeRetryStates(filtered)
}

/**
 * Clear all retry states for a run
 */
export async function clearRunRetryStates(runId: string): Promise<void> {
  // Clear from memory
  for (const key of Array.from(retryStates.keys())) {
    if (key.startsWith(`${runId}:`)) {
      retryStates.delete(key)
    }
  }
  
  // Clear from disk
  const allStates = await readRetryStates()
  const filtered = allStates.filter(s => s.runId !== runId)
  await writeRetryStates(filtered)
}

/**
 * Get summary stats for retry states
 */
export async function getRetryStats(): Promise<{
  total: number
  pending: number
  retrying: number
  exhausted: number
  succeeded: number
}> {
  const allStates = await readRetryStates()
  
  return {
    total: allStates.length,
    pending: allStates.filter(s => s.status === 'pending').length,
    retrying: allStates.filter(s => s.status === 'retrying').length,
    exhausted: allStates.filter(s => s.status === 'exhausted').length,
    succeeded: allStates.filter(s => s.status === 'succeeded').length,
  }
}

// Persistence helpers

async function loadRetryState(runId: string, stepOrder: number): Promise<RetryState | null> {
  const allStates = await readRetryStates()
  const state = allStates.find(
    s => s.runId === runId && s.stepOrder === stepOrder
  )
  
  if (state) {
    const key = makeRetryKey(runId, stepOrder)
    retryStates.set(key, state)
  }
  
  return state || null
}

async function persistRetryState(state: RetryState): Promise<void> {
  const allStates = await readRetryStates()
  const idx = allStates.findIndex(
    s => s.runId === state.runId && s.stepOrder === state.stepOrder
  )
  
  if (idx >= 0) {
    allStates[idx] = state
  } else {
    allStates.push(state)
  }
  
  await writeRetryStates(allStates)
}

/**
 * Prune old retry states (keep recent, remove old exhausted/succeeded)
 */
export async function pruneRetryStates(maxAgeDays: number = 7): Promise<number> {
  const allStates = await readRetryStates()
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  
  const toKeep = allStates.filter(s => {
    // Always keep active states
    if (s.status === 'pending' || s.status === 'retrying') {
      return true
    }
    // Keep recent finished states
    const updatedAt = new Date(s.updatedAt).getTime()
    return updatedAt > cutoff
  })
  
  const removed = allStates.length - toKeep.length
  
  if (removed > 0) {
    await writeRetryStates(toKeep)
    
    // Also clear from memory
    for (const state of allStates) {
      if (!toKeep.includes(state)) {
        const key = makeRetryKey(state.runId, state.stepOrder)
        retryStates.delete(key)
      }
    }
  }
  
  return removed
}
