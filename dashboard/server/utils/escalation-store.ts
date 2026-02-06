import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
/**
 * EscalationStore - Manages escalations when workers fail after max retries
 * 
 * Escalations are created when a task exhausts retry attempts. They remain
 * open until manually resolved or dismissed by a human.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'

const ESCALATIONS_PATH = join(ORCHESTRATOR_DATA_DIR, 'escalations.json')

export type EscalationStatus = 'open' | 'resolved' | 'dismissed'
export type EscalationSeverity = 'low' | 'medium' | 'high' | 'critical'

export interface Escalation {
  id: string
  
  // Context from the failed task
  runId: string
  pipelineId: string
  pipelineName: string
  stepOrder: number
  roleId: string
  roleName: string
  taskId?: string
  
  // Failure details
  error: string
  attemptCount: number
  maxAttempts: number
  lastAttemptAt: string
  
  // Resolution tracking
  status: EscalationStatus
  severity: EscalationSeverity
  createdAt: string
  resolvedAt?: string
  resolvedBy?: string
  resolution?: string
  
  // Additional context
  projectDir?: string
  notes?: string
}

export interface CreateEscalationParams {
  runId: string
  pipelineId: string
  pipelineName: string
  stepOrder: number
  roleId: string
  roleName: string
  taskId?: string
  error: string
  attemptCount: number
  maxAttempts: number
  projectDir?: string
  severity?: EscalationSeverity
}

/**
 * Read all escalations
 */
export async function readEscalations(): Promise<Escalation[]> {
  try {
    const content = await readFile(ESCALATIONS_PATH, 'utf-8')
    return JSON.parse(content)
  } catch {
    return []
  }
}

/**
 * Write escalations to storage
 */
async function writeEscalations(escalations: Escalation[]): Promise<void> {
  await mkdir(dirname(ESCALATIONS_PATH), { recursive: true })
  await writeFile(ESCALATIONS_PATH, JSON.stringify(escalations, null, 2))
}

/**
 * Create a new escalation
 */
export async function createEscalation(params: CreateEscalationParams): Promise<Escalation> {
  const escalations = await readEscalations()
  
  const escalation: Escalation = {
    id: `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    runId: params.runId,
    pipelineId: params.pipelineId,
    pipelineName: params.pipelineName,
    stepOrder: params.stepOrder,
    roleId: params.roleId,
    roleName: params.roleName,
    taskId: params.taskId,
    error: params.error,
    attemptCount: params.attemptCount,
    maxAttempts: params.maxAttempts,
    lastAttemptAt: new Date().toISOString(),
    status: 'open',
    severity: params.severity || determineSeverity(params.attemptCount, params.maxAttempts),
    createdAt: new Date().toISOString(),
    projectDir: params.projectDir,
  }
  
  escalations.push(escalation)
  await writeEscalations(escalations)
  
  return escalation
}

/**
 * Get escalation by ID
 */
export async function getEscalation(id: string): Promise<Escalation | undefined> {
  const escalations = await readEscalations()
  return escalations.find(e => e.id === id)
}

/**
 * Get all open escalations
 */
export async function getOpenEscalations(): Promise<Escalation[]> {
  const escalations = await readEscalations()
  return escalations.filter(e => e.status === 'open')
}

/**
 * Get escalations for a specific pipeline run
 */
export async function getEscalationsByRun(runId: string): Promise<Escalation[]> {
  const escalations = await readEscalations()
  return escalations.filter(e => e.runId === runId)
}

/**
 * Get escalations for a specific pipeline
 */
export async function getEscalationsByPipeline(pipelineId: string): Promise<Escalation[]> {
  const escalations = await readEscalations()
  return escalations.filter(e => e.pipelineId === pipelineId)
}

/**
 * Resolve an escalation
 */
export async function resolveEscalation(
  id: string,
  resolution: string,
  resolvedBy?: string
): Promise<Escalation | undefined> {
  const escalations = await readEscalations()
  const escalation = escalations.find(e => e.id === id)
  
  if (escalation) {
    escalation.status = 'resolved'
    escalation.resolvedAt = new Date().toISOString()
    escalation.resolution = resolution
    if (resolvedBy) escalation.resolvedBy = resolvedBy
    await writeEscalations(escalations)
  }
  
  return escalation
}

/**
 * Find and resolve all open escalations for a specific taskId
 * Used when a previously-failed task completes successfully
 */
export async function resolveEscalationsByTaskId(
  taskId: string,
  resolution?: string,
  resolvedBy?: string
): Promise<Escalation[]> {
  const escalations = await readEscalations()
  const resolved: Escalation[] = []
  let modified = false
  
  for (const escalation of escalations) {
    if (escalation.taskId === taskId && escalation.status === 'open') {
      escalation.status = 'resolved'
      escalation.resolvedAt = new Date().toISOString()
      escalation.resolution = resolution || 'Task completed successfully'
      if (resolvedBy) escalation.resolvedBy = resolvedBy
      resolved.push(escalation)
      modified = true
    }
  }
  
  if (modified) {
    await writeEscalations(escalations)
  }
  
  return resolved
}

/**
 * Dismiss an escalation (acknowledge without fixing)
 */
export async function dismissEscalation(
  id: string,
  reason?: string,
  dismissedBy?: string
): Promise<Escalation | undefined> {
  const escalations = await readEscalations()
  const escalation = escalations.find(e => e.id === id)
  
  if (escalation) {
    escalation.status = 'dismissed'
    escalation.resolvedAt = new Date().toISOString()
    escalation.resolution = reason || 'Dismissed without resolution'
    if (dismissedBy) escalation.resolvedBy = dismissedBy
    await writeEscalations(escalations)
  }
  
  return escalation
}

/**
 * Add notes to an escalation
 */
export async function addEscalationNote(id: string, note: string): Promise<Escalation | undefined> {
  const escalations = await readEscalations()
  const escalation = escalations.find(e => e.id === id)
  
  if (escalation) {
    const timestamp = new Date().toISOString()
    const newNote = `[${timestamp}] ${note}`
    escalation.notes = escalation.notes 
      ? `${escalation.notes}\n${newNote}`
      : newNote
    await writeEscalations(escalations)
  }
  
  return escalation
}

/**
 * Update escalation severity
 */
export async function updateEscalationSeverity(
  id: string,
  severity: EscalationSeverity
): Promise<Escalation | undefined> {
  const escalations = await readEscalations()
  const escalation = escalations.find(e => e.id === id)
  
  if (escalation) {
    escalation.severity = severity
    await writeEscalations(escalations)
  }
  
  return escalation
}

/**
 * Get escalation counts by status
 */
export async function getEscalationStats(): Promise<{
  open: number
  resolved: number
  dismissed: number
  total: number
  bySeverity: Record<EscalationSeverity, number>
}> {
  const escalations = await readEscalations()
  
  const stats = {
    open: 0,
    resolved: 0,
    dismissed: 0,
    total: escalations.length,
    bySeverity: {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    },
  }
  
  for (const e of escalations) {
    stats[e.status]++
    stats.bySeverity[e.severity]++
  }
  
  return stats
}

/**
 * Prune old resolved/dismissed escalations (keep last N days)
 */
export async function pruneOldEscalations(keepDays: number = 30): Promise<number> {
  const escalations = await readEscalations()
  const cutoff = Date.now() - (keepDays * 24 * 60 * 60 * 1000)
  
  const toKeep = escalations.filter(e => {
    // Always keep open escalations
    if (e.status === 'open') return true
    // Keep resolved/dismissed within retention period
    const resolvedTime = e.resolvedAt ? new Date(e.resolvedAt).getTime() : 0
    return resolvedTime > cutoff
  })
  
  const removed = escalations.length - toKeep.length
  
  if (removed > 0) {
    await writeEscalations(toKeep)
  }
  
  return removed
}

/**
 * Determine severity based on retry context
 */
function determineSeverity(attemptCount: number, maxAttempts: number): EscalationSeverity {
  // All retries exhausted at max attempts = at least medium
  if (attemptCount >= maxAttempts) {
    return maxAttempts >= 3 ? 'high' : 'medium'
  }
  return 'low'
}
