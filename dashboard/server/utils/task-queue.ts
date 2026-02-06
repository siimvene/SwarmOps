import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
/**
 * TaskQueue - Manages work-queue.json for dashboard visibility
 * 
 * Creates task entries when pipeline steps spawn, updates status on completion,
 * and links workers to tasks via sessionKey.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'

const QUEUE_PATH = join(ORCHESTRATOR_DATA_DIR, 'work-queue.json')

export interface Task {
  id: string
  pipelineId: string
  pipelineName: string
  runId: string
  stepOrder: number
  roleId: string
  roleName: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  createdAt: string
  startedAt?: string
  completedAt?: string
  sessionKey?: string
  result?: string
  error?: string
}

/**
 * Read all tasks from the queue
 */
export async function readTaskQueue(): Promise<Task[]> {
  try {
    const content = await readFile(QUEUE_PATH, 'utf-8')
    return JSON.parse(content)
  } catch {
    return []
  }
}

/**
 * Write tasks to the queue
 */
async function writeTaskQueue(tasks: Task[]): Promise<void> {
  await mkdir(dirname(QUEUE_PATH), { recursive: true })
  await writeFile(QUEUE_PATH, JSON.stringify(tasks, null, 2))
}

/**
 * Create a new task entry (status: pending)
 */
export async function createTask(params: {
  pipelineId: string
  pipelineName: string
  runId: string
  stepOrder: number
  roleId: string
  roleName: string
}): Promise<Task> {
  const tasks = await readTaskQueue()
  
  const task: Task = {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    pipelineId: params.pipelineId,
    pipelineName: params.pipelineName,
    runId: params.runId,
    stepOrder: params.stepOrder,
    roleId: params.roleId,
    roleName: params.roleName,
    status: 'pending',
    createdAt: new Date().toISOString(),
  }
  
  tasks.push(task)
  await writeTaskQueue(tasks)
  
  return task
}

/**
 * Update task to running status with sessionKey
 */
export async function startTask(taskId: string, sessionKey: string): Promise<void> {
  const tasks = await readTaskQueue()
  const task = tasks.find(t => t.id === taskId)
  
  if (task) {
    task.status = 'running'
    task.startedAt = new Date().toISOString()
    task.sessionKey = sessionKey
    await writeTaskQueue(tasks)
  }
}

/**
 * Mark task as completed
 */
export async function completeTask(taskId: string, result?: string): Promise<void> {
  const tasks = await readTaskQueue()
  const task = tasks.find(t => t.id === taskId)
  
  if (task) {
    task.status = 'completed'
    task.completedAt = new Date().toISOString()
    if (result) task.result = result
    await writeTaskQueue(tasks)
  }
}

/**
 * Mark task as failed
 */
export async function failTask(taskId: string, error?: string): Promise<void> {
  const tasks = await readTaskQueue()
  const task = tasks.find(t => t.id === taskId)
  
  if (task) {
    task.status = 'failed'
    task.completedAt = new Date().toISOString()
    if (error) task.error = error
    await writeTaskQueue(tasks)
  }
}

/**
 * Find task by runId and stepOrder
 */
export async function findTask(runId: string, stepOrder: number): Promise<Task | undefined> {
  const tasks = await readTaskQueue()
  return tasks.find(t => t.runId === runId && t.stepOrder === stepOrder)
}

/**
 * Find task by sessionKey
 */
export async function findTaskBySession(sessionKey: string): Promise<Task | undefined> {
  const tasks = await readTaskQueue()
  return tasks.find(t => t.sessionKey === sessionKey)
}

/**
 * Update task status by runId and stepOrder
 */
export async function updateTaskByRun(
  runId: string,
  stepOrder: number,
  update: { status: 'completed' | 'failed'; result?: string; error?: string }
): Promise<void> {
  const tasks = await readTaskQueue()
  const task = tasks.find(t => t.runId === runId && t.stepOrder === stepOrder)
  
  if (task) {
    task.status = update.status
    task.completedAt = new Date().toISOString()
    if (update.result) task.result = update.result
    if (update.error) task.error = update.error
    await writeTaskQueue(tasks)
  }
}

/**
 * Clean up old completed/failed tasks (keep last N)
 */
export async function pruneOldTasks(keepCount: number = 100): Promise<number> {
  const tasks = await readTaskQueue()
  
  // Separate active and finished tasks
  const active = tasks.filter(t => t.status === 'pending' || t.status === 'running')
  const finished = tasks.filter(t => t.status === 'completed' || t.status === 'failed')
  
  // Sort finished by completedAt descending, keep most recent
  finished.sort((a, b) => 
    new Date(b.completedAt || 0).getTime() - new Date(a.completedAt || 0).getTime()
  )
  
  const toKeep = [...active, ...finished.slice(0, keepCount)]
  const removed = tasks.length - toKeep.length
  
  if (removed > 0) {
    await writeTaskQueue(toKeep)
  }
  
  return removed
}
