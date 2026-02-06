import { PROJECTS_DIR as PROJ_DIR } from '~/server/utils/paths'
/**
 * Progress Watchdog
 * 
 * Monitors active projects for stalled progress and takes corrective action.
 * 
 * Checks every 5 minutes:
 * 1. Find projects in build/review phase with status "running"
 * 2. Check if progress.md was modified in last 10 minutes
 * 3. Check if any workers are actually active
 * 4. If stalled: retry failed workers or escalate
 */

import { readFile, writeFile, stat } from 'fs/promises'
import { join } from 'path'
import { readdirSync, existsSync } from 'fs'
import { logActivity, checkAndAdvancePhase, triggerPhaseWork } from './auto-advance'
import { broadcastProjectUpdate } from '../plugins/websocket'

const PROJECTS_DIR = PROJ_DIR
const STALL_THRESHOLD_MS = 10 * 60 * 1000  // 10 minutes
const MAX_TASK_RETRIES = 3

interface ProjectState {
  project: string
  phase: string
  status: string
  startedAt: string
  currentRunId?: string
  activeWorkers?: string[]
}

interface WatchdogResult {
  project: string
  status: 'healthy' | 'stalled' | 'recovered' | 'escalated'
  message: string
  action?: string
}

/**
 * Get all active projects (in build or review phase with running status)
 */
async function getActiveProjects(): Promise<string[]> {
  const activeProjects: string[] = []
  
  try {
    const entries = readdirSync(PROJECTS_DIR, { withFileTypes: true })
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      if (entry.name === 'swarmops-dashboard') continue  // Skip the dashboard itself
      
      const statePath = join(PROJECTS_DIR, entry.name, 'state.json')
      if (!existsSync(statePath)) continue
      
      try {
        const stateData = await readFile(statePath, 'utf-8')
        const state: ProjectState = JSON.parse(stateData)
        
        // Check if project is in an active phase
        if (['build', 'review', 'spec'].includes(state.phase) && 
            ['running', 'ready'].includes(state.status)) {
          activeProjects.push(entry.name)
        }
      } catch {
        // Skip projects with invalid state
      }
    }
  } catch (err) {
    console.error('[watchdog] Failed to list projects:', err)
  }
  
  return activeProjects
}

/**
 * Check if a project has made recent progress
 */
async function checkProjectProgress(projectName: string): Promise<{
  stalled: boolean
  lastActivity: Date | null
  reason?: string
}> {
  const projectPath = join(PROJECTS_DIR, projectName)
  const progressPath = join(projectPath, 'progress.md')
  const activityPath = join(projectPath, 'activity.jsonl')
  
  const now = Date.now()
  let lastActivity: Date | null = null
  
  // Check progress.md modification time
  try {
    const progressStat = await stat(progressPath)
    const progressAge = now - progressStat.mtimeMs
    if (progressAge < STALL_THRESHOLD_MS) {
      return { stalled: false, lastActivity: progressStat.mtime }
    }
    lastActivity = progressStat.mtime
  } catch {
    // No progress.md yet
  }
  
  // Check activity.jsonl modification time
  try {
    const activityStat = await stat(activityPath)
    const activityAge = now - activityStat.mtimeMs
    if (activityAge < STALL_THRESHOLD_MS) {
      return { stalled: false, lastActivity: activityStat.mtime }
    }
    if (!lastActivity || activityStat.mtime > lastActivity) {
      lastActivity = activityStat.mtime
    }
  } catch {
    // No activity.jsonl yet
  }
  
  // Check state.json for recent updates
  try {
    const statePath = join(projectPath, 'state.json')
    const stateStat = await stat(statePath)
    const stateAge = now - stateStat.mtimeMs
    if (stateAge < STALL_THRESHOLD_MS) {
      return { stalled: false, lastActivity: stateStat.mtime }
    }
  } catch {
    // Ignore
  }
  
  // If we get here, no recent activity
  const stalledMinutes = lastActivity 
    ? Math.round((now - lastActivity.getTime()) / 60000)
    : 'unknown'
  
  return { 
    stalled: true, 
    lastActivity,
    reason: `No activity for ${stalledMinutes} minutes`
  }
}

/**
 * Get incomplete tasks from progress.md
 */
async function getIncompleteTasks(projectName: string): Promise<string[]> {
  const progressPath = join(PROJECTS_DIR, projectName, 'progress.md')
  
  try {
    const content = await readFile(progressPath, 'utf-8')
    const tasks: string[] = []
    
    // Match unchecked tasks with @id
    const taskRegex = /- \[ \] .+@id\(([^)]+)\)/g
    let match
    while ((match = taskRegex.exec(content)) !== null) {
      tasks.push(match[1])
    }
    
    return tasks
  } catch {
    return []
  }
}

/**
 * Get retry count for a task from activity log
 */
async function getTaskRetryCount(projectName: string, taskId: string): Promise<number> {
  const activityPath = join(PROJECTS_DIR, projectName, 'activity.jsonl')
  
  try {
    const content = await readFile(activityPath, 'utf-8')
    const lines = content.trim().split('\n')
    
    let retries = 0
    for (const line of lines) {
      try {
        const event = JSON.parse(line)
        if (event.type === 'watchdog-retry' && event.taskId === taskId) {
          retries++
        }
      } catch {
        // Skip malformed lines
      }
    }
    
    return retries
  } catch {
    return 0
  }
}

/**
 * Attempt to recover a stalled project
 */
async function recoverStalledProject(projectName: string): Promise<WatchdogResult> {
  const projectPath = join(PROJECTS_DIR, projectName)
  
  // First, check if phase should advance (this handles spec→build, build→review, etc.)
  try {
    const advanceResult = await checkAndAdvancePhase(projectPath, projectName, { projectsDir: PROJECTS_DIR })
    
    if (advanceResult.advanced && advanceResult.newPhase) {
      await logActivity(projectPath, projectName, 'watchdog-advance', 
        `Watchdog detected phase ready to advance: ${advanceResult.message}`)
      
      // Trigger work for the new phase
      const triggerResult = await triggerPhaseWork(projectPath, projectName, advanceResult.newPhase)
      
      return {
        project: projectName,
        status: 'recovered',
        message: `Phase advanced to ${advanceResult.newPhase}`,
        action: triggerResult.message
      }
    }
  } catch (err) {
    console.error(`[watchdog] Phase advance check failed for ${projectName}:`, err)
  }
  
  // Get incomplete tasks
  const incompleteTasks = await getIncompleteTasks(projectName)
  
  if (incompleteTasks.length === 0) {
    // No incomplete tasks and phase didn't advance - might need manual check
    await logActivity(projectPath, projectName, 'watchdog-check', 
      'Watchdog found stalled project but no incomplete tasks and phase cannot advance. Manual check needed.')
    
    return {
      project: projectName,
      status: 'escalated',
      message: 'Stalled but no incomplete tasks found and phase cannot advance',
      action: 'Manual intervention needed'
    }
  }
  
  // Try to retry the first incomplete task
  const taskToRetry = incompleteTasks[0]
  const retryCount = await getTaskRetryCount(projectName, taskToRetry)
  
  if (retryCount >= MAX_TASK_RETRIES) {
    // Too many retries - escalate
    await logActivity(projectPath, projectName, 'watchdog-escalate', 
      `Task ${taskToRetry} failed after ${retryCount} watchdog retries. Manual intervention needed.`)
    
    return {
      project: projectName,
      status: 'escalated',
      message: `Task ${taskToRetry} exceeded max retries (${MAX_TASK_RETRIES})`,
      action: 'Manual intervention required'
    }
  }
  
  // Log the retry attempt
  await logActivity(projectPath, projectName, 'watchdog-retry', 
    `Watchdog detected stall. Triggering orchestrator to retry task ${taskToRetry} (attempt ${retryCount + 1}/${MAX_TASK_RETRIES})`,
    { taskId: taskToRetry, retryCount: retryCount + 1 })
  
  // Trigger the orchestrator to continue
  try {
    const response = await fetch(`http://localhost:3939/api/projects/${projectName}/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        force: true,
        reason: 'watchdog-recovery',
        retryTask: taskToRetry
      })
    })
    
    if (response.ok) {
      return {
        project: projectName,
        status: 'recovered',
        message: `Triggered orchestrator to retry task ${taskToRetry}`,
        action: `Retry attempt ${retryCount + 1}`
      }
    } else {
      const error = await response.text()
      return {
        project: projectName,
        status: 'escalated',
        message: `Failed to trigger orchestrator: ${error}`,
        action: 'Check orchestrator logs'
      }
    }
  } catch (err) {
    return {
      project: projectName,
      status: 'escalated',
      message: `Failed to call orchestrator: ${err}`,
      action: 'Check server connectivity'
    }
  }
}

/**
 * Main watchdog function - run periodically
 */
export async function runWatchdog(): Promise<WatchdogResult[]> {
  console.log('[watchdog] Starting watchdog check...')
  const results: WatchdogResult[] = []
  
  const activeProjects = await getActiveProjects()
  console.log(`[watchdog] Found ${activeProjects.length} active projects`)
  
  for (const projectName of activeProjects) {
    const progress = await checkProjectProgress(projectName)
    
    if (!progress.stalled) {
      results.push({
        project: projectName,
        status: 'healthy',
        message: 'Recent activity detected'
      })
      continue
    }
    
    console.log(`[watchdog] Project ${projectName} appears stalled: ${progress.reason}`)
    
    // Attempt recovery
    const recoveryResult = await recoverStalledProject(projectName)
    results.push(recoveryResult)
  }
  
  console.log(`[watchdog] Check complete. Results: ${JSON.stringify(results)}`)
  return results
}

/**
 * Clean up finished sessions (called periodically)
 */
export async function cleanupFinishedSessions(): Promise<number> {
  const GATEWAY_URL = 'http://127.0.0.1:18789'
  const GATEWAY_TOKEN = 'eaa3cf1ca047c50cba746ed07ae6dcf7ad5fa17c18734a1a'
  
  try {
    // Get all sessions
    const response = await fetch(`${GATEWAY_URL}/tools/invoke`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tool: 'sessions_list',
        args: { limit: 100 }
      })
    })
    
    if (!response.ok) return 0
    
    const data = await response.json()
    const sessions = data.result?.details?.sessions || data.sessions || []
    
    // Find swarm sessions that are old (> 30 min) and have finished
    const now = Date.now()
    const oldSwarmSessions = sessions.filter((s: any) => {
      if (!s.label?.startsWith('swarm:')) return false
      const age = now - s.updatedAt
      return age > 30 * 60 * 1000  // 30 minutes old
    })
    
    // Note: We can't actually delete sessions via the gateway API
    // This is informational only for now
    console.log(`[watchdog] Found ${oldSwarmSessions.length} old swarm sessions`)
    
    return oldSwarmSessions.length
  } catch (err) {
    console.error('[watchdog] Failed to check sessions:', err)
    return 0
  }
}
