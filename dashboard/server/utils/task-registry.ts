import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
/**
 * Task Registry - Track task states to prevent duplicate spawns
 * 
 * Provides:
 * - canSpawnTask: Check if a task can be spawned (not already running)
 * - registerTask: Mark task as running when spawned
 * - updateTaskStatus: Update task status on completion/failure
 * - getTaskStatus: Get current task status
 * - clearTask: Remove task from registry (cleanup)
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'

const DATA_DIR = ORCHESTRATOR_DATA_DIR
const REGISTRY_FILE = join(DATA_DIR, 'task-registry.json')

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface TaskEntry {
  taskId: string
  projectName: string
  runId?: string
  phaseNumber?: number
  status: TaskStatus
  workerId?: string
  workerBranch?: string
  startedAt?: string
  completedAt?: string
  error?: string
  output?: string
}

interface TaskRegistry {
  tasks: Record<string, TaskEntry>  // Key: `${projectName}:${taskId}`
  lastUpdated: string
}

// In-memory cache for performance
let registryCache: TaskRegistry | null = null
let cacheLoadedAt = 0
const CACHE_TTL_MS = 5000  // Reload from disk every 5s

/**
 * Get registry key for a task
 */
function getTaskKey(projectName: string, taskId: string): string {
  return `${projectName}:${taskId}`
}

/**
 * Load registry from disk
 */
async function loadRegistry(): Promise<TaskRegistry> {
  const now = Date.now()
  
  // Use cache if fresh
  if (registryCache && (now - cacheLoadedAt) < CACHE_TTL_MS) {
    return registryCache
  }
  
  try {
    const data = await readFile(REGISTRY_FILE, 'utf-8')
    registryCache = JSON.parse(data)
    cacheLoadedAt = now
    return registryCache!
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      registryCache = { tasks: {}, lastUpdated: new Date().toISOString() }
      cacheLoadedAt = now
      return registryCache
    }
    throw err
  }
}

/**
 * Save registry to disk
 */
async function saveRegistry(registry: TaskRegistry): Promise<void> {
  registry.lastUpdated = new Date().toISOString()
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2))
  registryCache = registry
  cacheLoadedAt = Date.now()
}

/**
 * Check if a task can be spawned (not already running)
 */
export async function canSpawnTask(projectName: string, taskId: string): Promise<{
  canSpawn: boolean
  reason?: string
  existingStatus?: TaskStatus
  existingEntry?: TaskEntry
}> {
  const registry = await loadRegistry()
  const key = getTaskKey(projectName, taskId)
  const entry = registry.tasks[key]
  
  if (!entry) {
    return { canSpawn: true }
  }
  
  // Task already tracked - check status
  if (entry.status === 'running') {
    return {
      canSpawn: false,
      reason: `Task ${taskId} is already running (started: ${entry.startedAt})`,
      existingStatus: entry.status,
      existingEntry: entry,
    }
  }
  
  if (entry.status === 'completed') {
    return {
      canSpawn: false,
      reason: `Task ${taskId} is already completed`,
      existingStatus: entry.status,
      existingEntry: entry,
    }
  }
  
  // Status is pending, failed, or cancelled - can retry
  return {
    canSpawn: true,
    existingStatus: entry.status,
    existingEntry: entry,
  }
}

/**
 * Register a task as running
 */
export async function registerTask(opts: {
  projectName: string
  taskId: string
  runId?: string
  phaseNumber?: number
  workerId?: string
  workerBranch?: string
}): Promise<TaskEntry> {
  const { projectName, taskId, runId, phaseNumber, workerId, workerBranch } = opts
  const registry = await loadRegistry()
  const key = getTaskKey(projectName, taskId)
  
  const entry: TaskEntry = {
    taskId,
    projectName,
    runId,
    phaseNumber,
    status: 'running',
    workerId,
    workerBranch,
    startedAt: new Date().toISOString(),
  }
  
  registry.tasks[key] = entry
  await saveRegistry(registry)
  
  console.log(`[task-registry] Registered task ${taskId} as running for project ${projectName}`)
  return entry
}

/**
 * Update task status
 */
export async function updateTaskStatus(opts: {
  projectName: string
  taskId: string
  status: TaskStatus
  output?: string
  error?: string
}): Promise<TaskEntry | null> {
  const { projectName, taskId, status, output, error } = opts
  const registry = await loadRegistry()
  const key = getTaskKey(projectName, taskId)
  
  const entry = registry.tasks[key]
  if (!entry) {
    console.warn(`[task-registry] Task ${taskId} not found in registry for project ${projectName}`)
    return null
  }
  
  entry.status = status
  if (output) entry.output = output
  if (error) entry.error = error
  
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    entry.completedAt = new Date().toISOString()
  }
  
  await saveRegistry(registry)
  console.log(`[task-registry] Updated task ${taskId} status to ${status} for project ${projectName}`)
  return entry
}

/**
 * Get task status
 */
export async function getTaskStatus(projectName: string, taskId: string): Promise<TaskEntry | null> {
  const registry = await loadRegistry()
  const key = getTaskKey(projectName, taskId)
  return registry.tasks[key] || null
}

/**
 * Get all tasks for a project
 */
export async function getProjectTasks(projectName: string): Promise<TaskEntry[]> {
  const registry = await loadRegistry()
  return Object.values(registry.tasks).filter(t => t.projectName === projectName)
}

/**
 * Get all running tasks for a project
 */
export async function getRunningTasks(projectName: string): Promise<TaskEntry[]> {
  const registry = await loadRegistry()
  return Object.values(registry.tasks).filter(
    t => t.projectName === projectName && t.status === 'running'
  )
}

/**
 * Clear a task from registry (cleanup)
 */
export async function clearTask(projectName: string, taskId: string): Promise<boolean> {
  const registry = await loadRegistry()
  const key = getTaskKey(projectName, taskId)
  
  if (!registry.tasks[key]) {
    return false
  }
  
  delete registry.tasks[key]
  await saveRegistry(registry)
  console.log(`[task-registry] Cleared task ${taskId} from registry for project ${projectName}`)
  return true
}

/**
 * Clear all tasks for a project
 */
export async function clearProjectTasks(projectName: string): Promise<number> {
  const registry = await loadRegistry()
  let cleared = 0
  
  for (const key of Object.keys(registry.tasks)) {
    if (registry.tasks[key].projectName === projectName) {
      delete registry.tasks[key]
      cleared++
    }
  }
  
  if (cleared > 0) {
    await saveRegistry(registry)
    console.log(`[task-registry] Cleared ${cleared} tasks for project ${projectName}`)
  }
  
  return cleared
}

/**
 * Clear stale running tasks (older than given timeout)
 * Used for cleanup of abandoned tasks
 */
export async function clearStaleTasks(maxAgeMs: number = 3600000): Promise<number> {
  const registry = await loadRegistry()
  const now = Date.now()
  let cleared = 0
  
  for (const [key, entry] of Object.entries(registry.tasks)) {
    if (entry.status === 'running' && entry.startedAt) {
      const startedAt = new Date(entry.startedAt).getTime()
      if ((now - startedAt) > maxAgeMs) {
        entry.status = 'failed'
        entry.error = 'Task timed out (stale)'
        entry.completedAt = new Date().toISOString()
        cleared++
        console.log(`[task-registry] Marked stale task ${entry.taskId} as failed (age: ${Math.round((now - startedAt) / 1000)}s)`)
      }
    }
  }
  
  if (cleared > 0) {
    await saveRegistry(registry)
  }
  
  return cleared
}

/**
 * Filter tasks that can be spawned (for deduplication)
 * Returns only tasks that are not already running
 */
export async function filterSpawnableTasks<T extends { id: string }>(
  projectName: string,
  tasks: T[]
): Promise<{ spawnable: T[]; skipped: { task: T; reason: string }[] }> {
  const spawnable: T[] = []
  const skipped: { task: T; reason: string }[] = []
  
  for (const task of tasks) {
    const check = await canSpawnTask(projectName, task.id)
    if (check.canSpawn) {
      spawnable.push(task)
    } else {
      skipped.push({ task, reason: check.reason || 'Unknown' })
    }
  }
  
  return { spawnable, skipped }
}
