import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
/**
 * Ledger Writer - Append pipeline/task events to ledger.jsonl
 */

import { appendFile, mkdir } from 'fs/promises'
import { join } from 'path'

const DATA_DIR = ORCHESTRATOR_DATA_DIR
const LEDGER_PATH = join(DATA_DIR, 'ledger.jsonl')

export type LedgerEntryType =
  | 'pipeline_started'
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'pipeline_completed'
  | 'worker_spawned'
  | 'worker_completed'
  | 'worker_failed'

export interface LedgerEntry {
  id: string
  timestamp: string
  type: LedgerEntryType
  runId?: string
  pipelineId?: string
  pipelineName?: string
  stepOrder?: number
  roleId?: string
  roleName?: string
  sessionKey?: string
  label?: string
  model?: string
  task?: string
  duration?: number
  output?: string
  error?: string
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export async function appendLedgerEntry(
  entry: Omit<LedgerEntry, 'id' | 'timestamp'>
): Promise<LedgerEntry> {
  const fullEntry: LedgerEntry = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    ...entry,
  }

  try {
    await mkdir(DATA_DIR, { recursive: true })
    await appendFile(LEDGER_PATH, JSON.stringify(fullEntry) + '\n')
  } catch (err) {
    console.error('[ledger-writer] Failed to write entry:', err)
  }

  return fullEntry
}

export async function logPipelineStarted(opts: {
  runId: string
  pipelineId: string
  pipelineName: string
}): Promise<LedgerEntry> {
  return appendLedgerEntry({
    type: 'pipeline_started',
    runId: opts.runId,
    pipelineId: opts.pipelineId,
    pipelineName: opts.pipelineName,
  })
}

export async function logTaskStarted(opts: {
  runId: string
  pipelineId: string
  pipelineName: string
  stepOrder: number
  roleId: string
  roleName?: string
  sessionKey?: string
}): Promise<LedgerEntry> {
  return appendLedgerEntry({
    type: 'task_started',
    runId: opts.runId,
    pipelineId: opts.pipelineId,
    pipelineName: opts.pipelineName,
    stepOrder: opts.stepOrder,
    roleId: opts.roleId,
    roleName: opts.roleName,
    sessionKey: opts.sessionKey,
  })
}

export async function logTaskCompleted(opts: {
  runId: string
  pipelineId: string
  pipelineName: string
  stepOrder: number
  roleId: string
  roleName?: string
  sessionKey?: string
  duration?: number
  output?: string
}): Promise<LedgerEntry> {
  return appendLedgerEntry({
    type: 'task_completed',
    runId: opts.runId,
    pipelineId: opts.pipelineId,
    pipelineName: opts.pipelineName,
    stepOrder: opts.stepOrder,
    roleId: opts.roleId,
    roleName: opts.roleName,
    sessionKey: opts.sessionKey,
    duration: opts.duration,
    output: opts.output,
  })
}

export async function logTaskFailed(opts: {
  runId: string
  pipelineId: string
  pipelineName: string
  stepOrder: number
  roleId: string
  roleName?: string
  sessionKey?: string
  duration?: number
  error?: string
}): Promise<LedgerEntry> {
  return appendLedgerEntry({
    type: 'task_failed',
    runId: opts.runId,
    pipelineId: opts.pipelineId,
    pipelineName: opts.pipelineName,
    stepOrder: opts.stepOrder,
    roleId: opts.roleId,
    roleName: opts.roleName,
    sessionKey: opts.sessionKey,
    duration: opts.duration,
    error: opts.error,
  })
}

export async function logPipelineCompleted(opts: {
  runId: string
  pipelineId: string
  pipelineName: string
  duration?: number
}): Promise<LedgerEntry> {
  return appendLedgerEntry({
    type: 'pipeline_completed',
    runId: opts.runId,
    pipelineId: opts.pipelineId,
    pipelineName: opts.pipelineName,
    duration: opts.duration,
  })
}

// Worker events (for any spawn, not just pipeline tasks)
export async function logWorkerSpawned(opts: {
  sessionKey: string
  label?: string
  model?: string
  task?: string
  roleId?: string
  roleName?: string
}): Promise<LedgerEntry> {
  return appendLedgerEntry({
    type: 'worker_spawned',
    sessionKey: opts.sessionKey,
    label: opts.label,
    model: opts.model,
    task: opts.task,
    roleId: opts.roleId,
    roleName: opts.roleName,
  })
}

export async function logWorkerCompleted(opts: {
  sessionKey: string
  label?: string
  duration?: number
  output?: string
}): Promise<LedgerEntry> {
  return appendLedgerEntry({
    type: 'worker_completed',
    sessionKey: opts.sessionKey,
    label: opts.label,
    duration: opts.duration,
    output: opts.output,
  })
}

export async function logWorkerFailed(opts: {
  sessionKey: string
  label?: string
  duration?: number
  error?: string
}): Promise<LedgerEntry> {
  return appendLedgerEntry({
    type: 'worker_failed',
    sessionKey: opts.sessionKey,
    label: opts.label,
    duration: opts.duration,
    error: opts.error,
  })
}
