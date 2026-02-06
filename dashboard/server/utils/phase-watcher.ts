import { PROJECTS_DIR as PROJ_DIR } from '~/server/utils/paths'
/**
 * Phase Watcher - Automatic phase advancement service
 * 
 * Polls project states and auto-advances when phase completion conditions are met.
 * Runs as a background service, checking every 30 seconds.
 */

import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import type { ProjectState, ProjectPhase } from '../types/project'
import { 
  checkAndAdvancePhase, 
  triggerPhaseWork, 
  logActivity,
  updateProjectPhase,
  triggerOrchestrator
} from './auto-advance'
import { parseTaskGraph, getReadyTasks } from './orchestrator'

const POLL_INTERVAL_MS = 30_000 // 30 seconds
const PROJECTS_DIR = PROJ_DIR

let pollInterval: ReturnType<typeof setInterval> | null = null
let isPolling = false

interface PhaseConditions {
  interview: () => Promise<{ ready: boolean; reason: string }>
  spec: () => Promise<{ ready: boolean; reason: string }>
  build: () => Promise<{ ready: boolean; reason: string }>
  review: () => Promise<{ ready: boolean; reason: string }>
}

/**
 * Check if a project should advance from current phase
 */
async function checkProjectPhaseAdvancement(
  projectName: string,
  projectPath: string,
  state: ProjectState
): Promise<{ shouldAdvance: boolean; nextPhase?: ProjectPhase; reason: string }> {
  const currentPhase = state.phase
  
  // Skip if already complete or not running
  if (currentPhase === 'complete') {
    return { shouldAdvance: false, reason: 'Already complete' }
  }
  
  if (state.status !== 'running' && state.status !== 'pending') {
    return { shouldAdvance: false, reason: `Status is ${state.status}` }
  }
  
  switch (currentPhase) {
    case 'interview': {
      // Check if interview.json has complete: true
      try {
        const interviewPath = join(projectPath, 'interview.json')
        const data = await readFile(interviewPath, 'utf-8')
        const interview = JSON.parse(data)
        if (interview.complete) {
          return { shouldAdvance: true, nextPhase: 'spec', reason: 'Interview marked complete' }
        }
      } catch {}
      return { shouldAdvance: false, reason: 'Interview not complete' }
    }
    
    case 'spec': {
      // Check if IMPLEMENTATION_PLAN.md exists AND progress.md has tasks
      const specPath = join(projectPath, 'specs', 'IMPLEMENTATION_PLAN.md')
      const progressPath = join(projectPath, 'progress.md')
      
      let hasSpec = false
      let hasTasks = false
      
      try {
        await readFile(specPath, 'utf-8')
        hasSpec = true
      } catch {}
      
      try {
        const progressContent = await readFile(progressPath, 'utf-8')
        // Check if there are @id() annotations (actual tasks)
        hasTasks = progressContent.includes('@id(')
      } catch {}
      
      if (hasSpec && hasTasks) {
        return { shouldAdvance: true, nextPhase: 'build', reason: 'Spec and task list exist' }
      }
      return { shouldAdvance: false, reason: `Missing: ${!hasSpec ? 'spec' : ''}${!hasTasks ? ' tasks' : ''}` }
    }
    
    case 'build': {
      // Check if all tasks in progress.md are done
      try {
        const progressPath = join(projectPath, 'progress.md')
        const progressContent = await readFile(progressPath, 'utf-8')
        const graph = parseTaskGraph(progressContent)
        
        if (graph.tasks.size === 0) {
          return { shouldAdvance: false, reason: 'No tasks found' }
        }
        
        const allDone = Array.from(graph.tasks.values()).every(t => t.done)
        if (allDone) {
          return { shouldAdvance: true, nextPhase: 'review', reason: 'All build tasks complete' }
        }
        
        const doneCount = Array.from(graph.tasks.values()).filter(t => t.done).length
        return { shouldAdvance: false, reason: `${doneCount}/${graph.tasks.size} tasks done` }
      } catch {}
      return { shouldAdvance: false, reason: 'Could not read progress' }
    }
    
    case 'review': {
      // Check if all tasks (including review tasks) are done
      // When all tasks marked [x] in progress.md, project is complete
      try {
        const progressPath = join(projectPath, 'progress.md')
        const progressContent = await readFile(progressPath, 'utf-8')
        const graph = parseTaskGraph(progressContent)
        
        if (graph.tasks.size === 0) {
          return { shouldAdvance: false, reason: 'No tasks found' }
        }
        
        const allDone = Array.from(graph.tasks.values()).every(t => t.done)
        if (allDone) {
          return { shouldAdvance: true, nextPhase: 'complete', reason: 'All tasks including review complete' }
        }
        
        const doneCount = Array.from(graph.tasks.values()).filter(t => t.done).length
        return { shouldAdvance: false, reason: `Review: ${doneCount}/${graph.tasks.size} tasks done` }
      } catch {}
      return { shouldAdvance: false, reason: 'Could not read progress' }
    }
    
    default:
      return { shouldAdvance: false, reason: `Unknown phase: ${currentPhase}` }
  }
}

/**
 * Check if a project needs work triggered for its current phase
 */
async function checkNeedsWork(
  projectName: string,
  projectPath: string,
  state: ProjectState
): Promise<{ needsWork: boolean; reason: string }> {
  // Only check running projects
  if (state.status !== 'running') {
    return { needsWork: false, reason: `Status is ${state.status}` }
  }
  
  // Check if current phase has pending work
  switch (state.phase) {
    case 'build': {
      // Check if there are ready tasks not being worked on
      try {
        const progressPath = join(projectPath, 'progress.md')
        const progressContent = await readFile(progressPath, 'utf-8')
        const graph = parseTaskGraph(progressContent)
        
        const incompleteTasks = Array.from(graph.tasks.values()).filter(t => !t.done)
        if (incompleteTasks.length > 0) {
          // Check ready tasks
          const readyTasks = incompleteTasks.filter(task => {
            return task.depends.every(depId => {
              const dep = graph.tasks.get(depId)
              return dep?.done === true
            })
          })
          
          if (readyTasks.length > 0) {
            return { needsWork: true, reason: `${readyTasks.length} ready tasks to spawn` }
          }
        }
      } catch {}
      return { needsWork: false, reason: 'No ready tasks' }
    }
    
    case 'spec': {
      // Check if spec work needs to be triggered
      const specPath = join(projectPath, 'specs', 'IMPLEMENTATION_PLAN.md')
      try {
        await readFile(specPath, 'utf-8')
        // Spec exists, no work needed
        return { needsWork: false, reason: 'Spec already exists' }
      } catch {
        // No spec yet - check if spec agent is already running (via activity log)
        try {
          const activityPath = join(projectPath, 'activity.jsonl')
          const activityContent = await readFile(activityPath, 'utf-8')
          const lines = activityContent.trim().split('\n').reverse() // Most recent first
          
          // Look for recent spec spawn (within last 10 minutes)
          const tenMinutesAgo = Date.now() - (10 * 60 * 1000)
          
          for (const line of lines.slice(0, 20)) { // Check last 20 entries
            try {
              const event = JSON.parse(line)
              const eventTime = new Date(event.timestamp).getTime()
              
              if (eventTime < tenMinutesAgo) break // Stop checking older events
              
              if (event.type === 'spawn' && event.message?.includes('Spec')) {
                return { needsWork: false, reason: 'Spec agent already running' }
              }
              if (event.type === 'spawn' && event.message?.toLowerCase().includes('architect')) {
                return { needsWork: false, reason: 'Spec agent already running' }
              }
            } catch {}
          }
        } catch {}
        
        // No recent spec spawn found - need to trigger
        return { needsWork: true, reason: 'No spec file, need to generate' }
      }
    }
    
    default:
      return { needsWork: false, reason: `Phase ${state.phase} does not need auto-trigger` }
  }
}

/**
 * Scan all projects and advance any that are ready
 */
async function pollProjects(): Promise<void> {
  if (isPolling) return
  isPolling = true
  
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true })
    const projectDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'))
    
    for (const dir of projectDirs) {
      const projectPath = join(PROJECTS_DIR, dir.name)
      const statePath = join(projectPath, 'state.json')
      
      // Skip if no state.json
      if (!existsSync(statePath)) continue
      
      let state: ProjectState
      try {
        const stateRaw = await readFile(statePath, 'utf-8')
        state = JSON.parse(stateRaw)
      } catch {
        continue
      }
      
      // Check if should advance to next phase
      const advanceResult = await checkProjectPhaseAdvancement(dir.name, projectPath, state)
      
      if (advanceResult.shouldAdvance && advanceResult.nextPhase) {
        console.log(`[phase-watcher] Auto-advancing ${dir.name}: ${state.phase} → ${advanceResult.nextPhase} (${advanceResult.reason})`)
        
        try {
          // Update phase
          await updateProjectPhase(projectPath, dir.name, advanceResult.nextPhase, 'running')
          
          // Log the advancement
          await logActivity(projectPath, dir.name, 'auto-advance', 
            `Phase watcher: ${state.phase} → ${advanceResult.nextPhase} (${advanceResult.reason})`)
          
          // Trigger work for new phase
          const triggerResult = await triggerPhaseWork(projectPath, dir.name, advanceResult.nextPhase)
          console.log(`[phase-watcher] Triggered ${advanceResult.nextPhase} work for ${dir.name}: ${triggerResult.message}`)
          
        } catch (err) {
          console.error(`[phase-watcher] Failed to advance ${dir.name}:`, err)
        }
        
        continue // Move to next project after advancing
      }
      
      // Check if current phase needs work triggered
      const workResult = await checkNeedsWork(dir.name, projectPath, state)
      
      if (workResult.needsWork) {
        console.log(`[phase-watcher] Triggering work for ${dir.name} (${state.phase}): ${workResult.reason}`)
        
        try {
          const triggerResult = await triggerPhaseWork(projectPath, dir.name, state.phase)
          console.log(`[phase-watcher] Triggered ${state.phase} work for ${dir.name}: ${triggerResult.message}`)
          
          await logActivity(projectPath, dir.name, 'auto-trigger', 
            `Phase watcher triggered ${state.phase}: ${workResult.reason}`)
          
        } catch (err) {
          console.error(`[phase-watcher] Failed to trigger work for ${dir.name}:`, err)
        }
      }
    }
  } catch (err) {
    console.error('[phase-watcher] Poll error:', err)
  } finally {
    isPolling = false
  }
}

/**
 * Start the phase watcher
 */
export function startPhaseWatcher(): void {
  if (pollInterval) {
    console.log('[phase-watcher] Already running')
    return
  }
  
  console.log(`[phase-watcher] Starting (poll interval: ${POLL_INTERVAL_MS}ms)`)
  
  // Run immediately, then on interval
  pollProjects()
  pollInterval = setInterval(pollProjects, POLL_INTERVAL_MS)
}

/**
 * Stop the phase watcher
 */
export function stopPhaseWatcher(): void {
  if (pollInterval) {
    console.log('[phase-watcher] Stopping')
    clearInterval(pollInterval)
    pollInterval = null
  }
}

/**
 * Check if watcher is running
 */
export function isPhaseWatcherRunning(): boolean {
  return pollInterval !== null
}

/**
 * Manually trigger a poll (for testing)
 */
export async function triggerPoll(): Promise<void> {
  await pollProjects()
}

/**
 * Get watcher status
 */
export function getPhaseWatcherStatus(): {
  running: boolean
  pollIntervalMs: number
  isCurrentlyPolling: boolean
} {
  return {
    running: pollInterval !== null,
    pollIntervalMs: POLL_INTERVAL_MS,
    isCurrentlyPolling: isPolling,
  }
}
