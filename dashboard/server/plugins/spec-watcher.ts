import { PROJECTS_DIR as PROJ_DIR } from '~/server/utils/paths'
/**
 * Spec File Watcher Plugin
 * 
 * Watches for spec/plan file creation and automatically triggers build phase.
 * This ensures the spec→build handover is automatic, not instruction-dependent.
 */

import { watch, existsSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { join, basename, dirname } from 'path'
import { readdirSync } from 'fs'

const PROJECTS_DIR = PROJ_DIR
const DEBOUNCE_MS = 5000  // Wait 5s after file change before triggering

// Track which projects we've already triggered to avoid duplicates
const triggeredProjects = new Set<string>()
const pendingTriggers = new Map<string, ReturnType<typeof setTimeout>>()

interface ProjectState {
  phase: string
  status: string
}

async function getProjectState(projectName: string): Promise<ProjectState | null> {
  const statePath = join(PROJECTS_DIR, projectName, 'state.json')
  try {
    const data = await readFile(statePath, 'utf-8')
    return JSON.parse(data)
  } catch {
    return null
  }
}

async function triggerBuildPhase(projectName: string): Promise<void> {
  // Check if already triggered
  if (triggeredProjects.has(projectName)) {
    console.log(`[spec-watcher] Already triggered build for ${projectName}, skipping`)
    return
  }

  // Verify project is in spec phase
  const state = await getProjectState(projectName)
  if (!state) {
    console.log(`[spec-watcher] No state found for ${projectName}`)
    return
  }

  if (state.phase !== 'spec') {
    console.log(`[spec-watcher] Project ${projectName} is in ${state.phase} phase, not spec`)
    return
  }

  // Verify spec file has content
  const specPath = join(PROJECTS_DIR, projectName, 'specs', 'IMPLEMENTATION_PLAN.md')
  const progressPath = join(PROJECTS_DIR, projectName, 'progress.md')
  
  let hasValidSpec = false
  
  try {
    const specContent = await readFile(specPath, 'utf-8')
    hasValidSpec = specContent.length > 100  // Must have real content
  } catch {}
  
  if (!hasValidSpec) {
    try {
      const progressContent = await readFile(progressPath, 'utf-8')
      // Check for task markers
      hasValidSpec = progressContent.includes('- [ ]') || progressContent.includes('- [x]')
    } catch {}
  }

  if (!hasValidSpec) {
    console.log(`[spec-watcher] No valid spec content found for ${projectName}`)
    return
  }

  console.log(`[spec-watcher] Spec file detected for ${projectName}, triggering build phase`)
  triggeredProjects.add(projectName)

  try {
    const response = await fetch(`http://localhost:3939/api/projects/${projectName}/spec-complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'file-watcher' })
    })

    if (response.ok) {
      console.log(`[spec-watcher] Successfully triggered build for ${projectName}`)
    } else {
      const error = await response.text()
      console.error(`[spec-watcher] Failed to trigger build for ${projectName}: ${error}`)
      triggeredProjects.delete(projectName)  // Allow retry
    }
  } catch (err) {
    console.error(`[spec-watcher] Error triggering build for ${projectName}:`, err)
    triggeredProjects.delete(projectName)  // Allow retry
  }
}

function scheduleCheck(projectName: string): void {
  // Clear any pending trigger
  const existing = pendingTriggers.get(projectName)
  if (existing) {
    clearTimeout(existing)
  }

  // Schedule new trigger with debounce
  const timeout = setTimeout(() => {
    pendingTriggers.delete(projectName)
    triggerBuildPhase(projectName)
  }, DEBOUNCE_MS)

  pendingTriggers.set(projectName, timeout)
}

function watchProject(projectName: string): void {
  const projectPath = join(PROJECTS_DIR, projectName)
  const specsDir = join(projectPath, 'specs')
  
  // Watch specs directory if it exists
  if (existsSync(specsDir)) {
    try {
      watch(specsDir, (eventType, filename) => {
        if (filename === 'IMPLEMENTATION_PLAN.md') {
          console.log(`[spec-watcher] Detected ${eventType} on ${projectName}/specs/${filename}`)
          scheduleCheck(projectName)
        }
      })
    } catch (err) {
      console.error(`[spec-watcher] Failed to watch specs dir for ${projectName}:`, err)
    }
  }

  // Also watch progress.md in project root
  try {
    watch(projectPath, (eventType, filename) => {
      if (filename === 'progress.md') {
        console.log(`[spec-watcher] Detected ${eventType} on ${projectName}/${filename}`)
        scheduleCheck(projectName)
      }
      // Also detect specs directory creation
      if (filename === 'specs') {
        const specsDir = join(projectPath, 'specs')
        if (existsSync(specsDir)) {
          watchProject(projectName)  // Re-setup watches
        }
      }
    })
  } catch (err) {
    console.error(`[spec-watcher] Failed to watch project dir for ${projectName}:`, err)
  }
}

function setupWatchers(): void {
  console.log('[spec-watcher] Setting up file watchers...')
  
  try {
    const entries = readdirSync(PROJECTS_DIR, { withFileTypes: true })
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      if (entry.name === 'swarmops-dashboard') continue
      
      watchProject(entry.name)
    }
    
    // Also watch for new project directories
    watch(PROJECTS_DIR, (eventType, filename) => {
      if (!filename || filename.startsWith('.') || filename === 'swarmops-dashboard') return
      
      const projectPath = join(PROJECTS_DIR, filename)
      if (existsSync(projectPath)) {
        console.log(`[spec-watcher] New project detected: ${filename}`)
        watchProject(filename)
      }
    })
    
    console.log(`[spec-watcher] Watching ${entries.length} projects`)
  } catch (err) {
    console.error('[spec-watcher] Failed to setup watchers:', err)
  }
}

// Reset triggered state for a project (e.g., when restarting build)
export function resetProjectTrigger(projectName: string): void {
  triggeredProjects.delete(projectName)
}

export default defineNitroPlugin((nitroApp) => {
  console.log('[spec-watcher] Plugin initialized')
  
  nitroApp.hooks.hook('ready', () => {
    // Small delay to let server fully start
    setTimeout(setupWatchers, 2000)
  })
})
