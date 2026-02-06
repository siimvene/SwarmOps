import { ORCHESTRATOR_DATA_DIR, SKILLS_DIR, DASHBOARD_PATH } from '~/server/utils/paths'
import { readFile, writeFile, appendFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { parseTaskGraph, getReadyTasks, type GraphTask } from '../../../utils/orchestrator'
import { wakeAgent } from '../../../utils/agent'
import { broadcastProjectUpdate } from '../../../plugins/websocket'
import { createWorktree, getWorkerBranch, cleanupRunWorktrees } from '../../../utils/worktree-manager'
import { initPhase, onWorkerComplete, getPhaseState, type PhaseState } from '../../../utils/phase-collector'
import { mergePhaseWithReview } from '../../../utils/phase-merger'
import { 
  initRetryState, 
  recordAttempt, 
  canRetry, 
  calculateRetryDelay, 
  getRetryState,
  clearRetryState,
  DEFAULT_RETRY_POLICY 
} from '../../../utils/retry-handler'
import { createEscalation } from '../../../utils/escalation-store'
import { canSpawnTask, registerTask, filterSpawnableTasks } from '../../../utils/task-registry'
import { requireAuth, validateProjectName } from '../../../utils/security'

interface OrchestrateRequest {
  action: 'start' | 'continue' | 'validate' | 'fix'
  completedTaskId?: string
  reviewFindings?: string  // Issues found by reviewer
}

// Track active runs for phase-based orchestration
interface ActiveRun {
  runId: string
  projectName: string
  projectPath: string
  dashboardPath: string
  currentPhaseNumber: number
  phases: PhaseInfo[]
  status: 'running' | 'merging' | 'reviewing' | 'completed' | 'failed'
  startedAt: string
  completedAt?: string
}

interface PhaseInfo {
  number: number
  name: string
  tasks: GraphTask[]
  status: 'pending' | 'running' | 'merging' | 'reviewing' | 'completed' | 'failed'
}

// In-memory store for active runs (keyed by project name)
const activeProjectRuns = new Map<string, ActiveRun>()

// Persistence directory for run state
const RUNS_DIR = join(ORCHESTRATOR_DATA_DIR, 'project-runs')

// Pending retries map (runId:taskId → timeout)
const pendingRetries = new Map<string, ReturnType<typeof setTimeout>>()

// Hash taskId to a unique number for per-task retry tracking
function hashTaskId(taskId: string): number {
  let hash = 0
  for (let i = 0; i < taskId.length; i++) {
    const char = taskId.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash) % 100000 // Keep within range
}

interface WorkerInfo {
  id: string
  roleId: string
  roleName: string
  taskId: string
  taskName: string
  projectName: string
  status: 'running' | 'completed' | 'error'
  startedAt: string
}

async function updateWorkersRegistry(worker: WorkerInfo) {
  const { homedir } = await import('os')
  const workersFile = join(homedir(), '.openclaw', 'workspace', 'swarmops-workers.json')
  
  let workers: WorkerInfo[] = []
  try {
    const data = await readFile(workersFile, 'utf-8')
    workers = JSON.parse(data)
  } catch {}
  
  // Update or add worker
  const idx = workers.findIndex(w => w.id === worker.id)
  if (idx >= 0) {
    workers[idx] = worker
  } else {
    workers.push(worker)
  }
  
  // Keep only last 50
  workers = workers.slice(-50)
  
  await writeFile(workersFile, JSON.stringify(workers, null, 2))
}

interface WorkerPromptOpts {
  task: GraphTask
  projectName: string
  projectPath: string
  dashboardPath: string
  runId: string
  phaseNumber: number
  worktreePath?: string
  workerBranch?: string
}

// Web design keywords that trigger the web-visuals skill
const WEB_DESIGN_KEYWORDS = [
  'html', 'css', 'landing', 'website', 'webpage', 'web page', 'hero', 
  'ui', 'interface', 'design', 'styling', 'layout', 'beautiful', 
  'modern', 'responsive', 'frontend', 'front-end', 'visual', 'svg'
]

function isWebDesignTask(task: GraphTask, projectName: string): boolean {
  const searchText = `${task.title} ${task.id} ${projectName}`.toLowerCase()
  return WEB_DESIGN_KEYWORDS.some(kw => searchText.includes(kw))
}

async function loadWebDesignSkill(): Promise<string | null> {
  try {
    const { readFile } = await import('fs/promises')
    const skillPath = join(SKILLS_DIR, 'web-visuals/SKILL.md')
    const content = await readFile(skillPath, 'utf-8')
    // Remove YAML frontmatter
    const withoutFrontmatter = content.replace(/^---[\s\S]*?---\n*/, '')
    return withoutFrontmatter
  } catch {
    return null
  }
}

async function buildWorkerPrompt(opts: WorkerPromptOpts): Promise<string> {
  const { task, projectName, projectPath, dashboardPath, runId, phaseNumber, worktreePath, workerBranch } = opts
  const workDir = worktreePath || dashboardPath
  
  if (task.role === 'reviewer') {
    return `[SWARMOPS REVIEWER] Project: ${projectName}
Task: ${task.title}
Task ID: ${task.id}
Run ID: ${runId} | Phase: ${phaseNumber}

You are a senior code reviewer. Your job is to CATCH BUGS before they ship.

**Working Directory:** ${workDir}
**Project Path:** ${projectPath}
**Dashboard Path:** ${dashboardPath}
${workerBranch ? `**Branch:** ${workerBranch}\n\nYou are working in an isolated git worktree.` : ''}

## Review Checklist (MUST follow)

### 1. List Modified Files
Run: find files changed by recent builders

### 2. Inspect EACH File for:

**Correctness (High severity if violated)**
- Variables/functions defined BEFORE use (check line numbers!)
- All imports resolve to existing files
- Function signatures match call sites
- No undefined references

**Integration (High severity)**
- Pieces from different builders fit together
- No duplicate definitions
- No conflicting edits to same code

**Framework (Vue/Nuxt)**
- Components imported before use
- Refs initialized properly

### 3. Report with Severity
For each issue:
- [Critical] Security/data loss
- [High] Likely bugs, broken features ← BLOCK APPROVAL
- [Medium] Maintainability
- [Low] Style

### 4. Decision
- **APPROVE** only if no Critical/High issues
- **REQUEST CHANGES** if High issues found (list fixes needed)
- Do NOT mark task done if High/Critical issues exist

Example issue format:
\`[High] Line 44 in docs.vue: contentMap references overviewContent before it's defined\`

Be THOROUGH. Check line-by-line. The last reviewer missed a hoisting bug that caused a 500 error.

**IMPORTANT - After Review:**

If you find High/Critical issues, POST your findings to spawn a fixer:
\`\`\`bash
curl -X POST http://localhost:3939/api/orchestrator/review-result \\
  -H "Content-Type: application/json" \\
  -d '{
    "status": "request_changes",
    "runId": "${runId}",
    "phaseNumber": ${phaseNumber},
    "findings": [
      {"severity": "high", "file": "path/to/file.vue", "line": 44, "description": "Variable used before defined", "fix": "Move definition before usage"}
    ]
  }'
\`\`\`

If all good (no High/Critical issues):
\`\`\`bash
curl -X POST http://localhost:3939/api/orchestrator/review-result \\
  -H "Content-Type: application/json" \\
  -d '{"status": "approved", "runId": "${runId}", "phaseNumber": ${phaseNumber}}'
\`\`\`

The server will mark the review task as done automatically.`
  }
  
  if (task.role === 'fixer') {
    // Fixer role - addresses issues found by reviewer
  return `[SWARMOPS FIXER] Project: ${projectName}
Task: Fix issues from code review
Task ID: ${task.id}
Run ID: ${runId} | Phase: ${phaseNumber}

You are a fixer agent addressing issues found during code review.

**Working Directory:** ${workDir}
**Project Path:** ${projectPath}
**Dashboard Path:** ${dashboardPath}
${workerBranch ? `**Branch:** ${workerBranch}\n\nYou are working in an isolated git worktree.` : ''}

## Issues to Fix

The reviewer found these problems that MUST be fixed:

${task.title}

## Instructions

1. Read each issue carefully
2. Locate the file and line number mentioned
3. Apply the fix
4. Verify your fix doesn't introduce new issues
${workerBranch ? '5. Commit your changes with a clear commit message' : ''}
${workerBranch ? '6' : '5'}. After ALL fixes are done, trigger re-review:

\`\`\`bash
curl -X POST http://localhost:3939/api/projects/${projectName}/fix-complete \\
  -H "Content-Type: application/json" \\
  -d '{"issuesFixed": 1, "runId": "${runId}", "phaseNumber": ${phaseNumber}}'
\`\`\`

${workerBranch ? '7' : '6'}. Report what you fixed

After fixing, the code will be re-reviewed. Make sure your fixes are correct.`
  }
  
  // Default: Builder role
  // NOTE: Workers no longer update progress.md themselves - the server handles it
  // This prevents sync issues between project folder and code repo
  const commitInstructions = workerBranch
    ? `3. Commit your changes with a clear commit message (you're on branch \`${workerBranch}\`)
4. Call the task-complete endpoint (this will mark the task done in progress.md):`
    : `3. Call the task-complete endpoint when done (this will mark the task done in progress.md):`

  // Load web design skill if this is a web/UI task
  let webDesignSkill = ''
  if (isWebDesignTask(task, projectName)) {
    const skill = await loadWebDesignSkill()
    if (skill) {
      webDesignSkill = `

## 🎨 Web Design Excellence Skill

You are building a visual web interface. Follow this skill guide for beautiful results:

${skill}

---
`
      console.log(`[orchestrate] Web design skill injected for task: ${task.id}`)
    }
  }

  return `[SWARMOPS BUILDER] Project: ${projectName}
Task: ${task.title}
Task ID: ${task.id}
Run ID: ${runId} | Phase: ${phaseNumber}

You are a builder working on this specific task.

**Working Directory:** ${workDir}
**Project Path:** ${projectPath}
**Dashboard Path:** ${dashboardPath}
${workerBranch ? `**Branch:** ${workerBranch}\n\nYou are working in an isolated git worktree. Make your changes and commit them before completing.` : ''}
${webDesignSkill}
**Your Task:**
1. Implement: ${task.title}
2. Work in the dashboard codebase
${commitInstructions}

\`\`\`bash
curl -X POST http://localhost:3939/api/projects/${projectName}/task-complete \\
  -H "Content-Type: application/json" \\
  -d '{"taskId": "${task.id}", "runId": "${runId}", "phaseNumber": ${phaseNumber}}'
\`\`\`

${workerBranch ? '6' : '5'}. Report what you built

Focus ONLY on this task. Don't do other tasks.`
}

/**
 * Handle worker spawn failure with retry logic
 */
async function handleWorkerSpawnFailure(params: {
  task: GraphTask
  runId: string
  phaseNumber: number
  projectName: string
  projectPath: string
  dashboardPath: string
  error: string
}): Promise<{
  willRetry: boolean
  attemptNumber: number
  maxAttempts: number
  delayMs?: number
  escalationId?: string
}> {
  const { task, runId, phaseNumber, projectName, projectPath, dashboardPath, error } = params
  
  // Generate unique stepOrder per task (hash taskId to number for unique key per task)
  const taskStepOrder = phaseNumber * 100000 + hashTaskId(task.id)
  
  // Initialize or get retry state (now unique per task)
  let retryState = await getRetryState(runId, taskStepOrder)
  
  if (!retryState) {
    retryState = await initRetryState({
      runId,
      stepOrder: taskStepOrder,
      taskId: task.id,
      policy: DEFAULT_RETRY_POLICY,
    })
  }
  
  // Record this failed attempt
  retryState = await recordAttempt({
    runId,
    stepOrder: taskStepOrder,
    success: false,
    error,
  })
  
  const attemptNumber = retryState.attempts.length
  const maxAttempts = retryState.policy.maxAttempts
  
  console.log(`[orchestrate-retry] Worker ${task.id} spawn failed (attempt ${attemptNumber}/${maxAttempts}): ${error}`)
  
  // Check if we're exhausted
  if (retryState.status === 'exhausted') {
    console.log(`[orchestrate-retry] Worker ${task.id} exhausted all ${maxAttempts} retries, creating escalation`)
    
    // Create escalation for human review
    const escalation = await createEscalation({
      runId,
      pipelineId: `project:${projectName}`,
      pipelineName: projectName,
      stepOrder: phaseNumber,
      roleId: task.role,
      roleName: task.role === 'reviewer' ? 'Reviewer' : 'Builder',
      taskId: task.id,
      error: `Spawn failures exhausted: ${error}`,
      attemptCount: attemptNumber,
      maxAttempts,
      projectDir: dashboardPath,
      severity: 'high',
    })
    
    // Log escalation to activity
    const activityFile = join(projectPath, 'activity.jsonl')
    const escalationEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'escalation-created',
      message: `Worker ${task.id} failed after ${attemptNumber} attempts, escalated for human review`,
      agent: 'orchestrator',
      runId,
      phaseNumber,
      taskId: task.id,
      escalationId: escalation.id,
      error,
    }
    await appendFile(activityFile, JSON.stringify(escalationEvent) + '\n')
    broadcastProjectUpdate(projectName, 'activity.jsonl')
    
    return {
      willRetry: false,
      attemptNumber,
      maxAttempts,
      escalationId: escalation.id,
    }
  }
  
  // Calculate delay and schedule retry
  const delayMs = calculateRetryDelay(retryState)
  console.log(`[orchestrate-retry] Scheduling retry for worker ${task.id} in ${delayMs}ms (attempt ${attemptNumber + 1}/${maxAttempts})`)
  
  // Log retry scheduled to activity
  const activityFile = join(projectPath, 'activity.jsonl')
  const retryEvent = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'spawn-retry-scheduled',
    message: `Worker ${task.id} spawn failed, retry ${attemptNumber + 1}/${maxAttempts} in ${Math.round(delayMs/1000)}s`,
    agent: 'orchestrator',
    runId,
    phaseNumber,
    taskId: task.id,
    attemptNumber,
    maxAttempts,
    delayMs,
    error,
  }
  await appendFile(activityFile, JSON.stringify(retryEvent) + '\n')
  broadcastProjectUpdate(projectName, 'activity.jsonl')
  
  // Create unique key for this task's retry timer
  const retryKey = `${runId}:${task.id}`
  
  // Cancel any existing retry for this worker
  if (pendingRetries.has(retryKey)) {
    clearTimeout(pendingRetries.get(retryKey)!)
    pendingRetries.delete(retryKey)
  }
  
  // Schedule the retry
  const timeout = setTimeout(async () => {
    pendingRetries.delete(retryKey)
    
    try {
      console.log(`[orchestrate-retry] Executing retry for worker ${task.id}`)
      
      // Re-trigger orchestrate for this project
      const response = await fetch(`http://localhost:3939/api/projects/${projectName}/orchestrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'continue' }),
      })
      
      if (!response.ok) {
        console.error(`[orchestrate-retry] Retry trigger failed for ${task.id}:`, await response.text())
      } else {
        console.log(`[orchestrate-retry] Retry triggered successfully for ${task.id}`)
      }
    } catch (err) {
      console.error(`[orchestrate-retry] Failed to execute retry for ${task.id}:`, err)
    }
  }, delayMs)
  
  pendingRetries.set(retryKey, timeout)
  
  return {
    willRetry: true,
    attemptNumber,
    maxAttempts,
    delayMs,
  }
}

/**
 * Parse phases from progress.md content
 * Looks for ## Phase N: or ### Phase N: headers (h2 or h3)
 */
function parsePhases(progressContent: string, graph: ReturnType<typeof parseTaskGraph>): PhaseInfo[] {
  const lines = progressContent.split('\n')
  const phases: PhaseInfo[] = []
  
  let currentPhase: PhaseInfo | null = null
  let currentPhaseTasks: GraphTask[] = []
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    
    // Check for phase header: ## Phase N: or ### Phase N: (supports both h2 and h3)
    const phaseMatch = line.match(/^#{2,3}\s+Phase\s+(\d+)(?::\s*(.*))?/i)
    if (phaseMatch) {
      // Save previous phase if exists
      if (currentPhase) {
        currentPhase.tasks = currentPhaseTasks
        phases.push(currentPhase)
      }
      
      const phaseNum = parseInt(phaseMatch[1], 10)
      const phaseName = phaseMatch[2]?.trim() || `Phase ${phaseNum}`
      
      currentPhase = {
        number: phaseNum,
        name: phaseName,
        tasks: [],
        status: 'pending',
      }
      currentPhaseTasks = []
      continue
    }
    
    // Check for task line while in a phase
    if (currentPhase) {
      const taskMatch = line.match(/@id\(([^)]+)\)/)
      if (taskMatch) {
        const taskId = taskMatch[1]
        const task = graph.tasks.get(taskId)
        if (task) {
          currentPhaseTasks.push(task)
        }
      }
    }
  }
  
  // Save last phase
  if (currentPhase) {
    currentPhase.tasks = currentPhaseTasks
    phases.push(currentPhase)
  }
  
  // Update phase status based on task completion
  for (const phase of phases) {
    const allDone = phase.tasks.length > 0 && phase.tasks.every(t => t.done)
    const anyRunning = phase.tasks.some(t => !t.done)
    
    if (allDone) {
      phase.status = 'completed'
    } else if (anyRunning && phases.indexOf(phase) === 0) {
      // First phase with incomplete tasks
      phase.status = 'running'
    } else {
      // Check if all previous phases are complete
      const phaseIndex = phases.indexOf(phase)
      const allPreviousComplete = phases.slice(0, phaseIndex).every(p => p.status === 'completed')
      if (allPreviousComplete && anyRunning) {
        phase.status = 'running'
      }
    }
  }
  
  return phases
}

/**
 * Get the current active phase (first incomplete phase with all dependencies met)
 */
function getCurrentPhase(phases: PhaseInfo[]): PhaseInfo | null {
  for (const phase of phases) {
    if (phase.status !== 'completed') {
      return phase
    }
  }
  return null
}

/**
 * Get ready tasks within a specific phase
 */
function getPhaseReadyTasks(phase: PhaseInfo, graph: ReturnType<typeof parseTaskGraph>): GraphTask[] {
  const ready: GraphTask[] = []
  
  for (const task of phase.tasks) {
    if (task.done) continue
    
    // Check if all dependencies are done
    const depsOk = task.depends.every(depId => {
      const dep = graph.tasks.get(depId)
      return dep?.done === true
    })
    
    if (depsOk) ready.push(task)
  }
  
  return ready
}

/**
 * Save run state to disk
 */
async function saveRunState(run: ActiveRun): Promise<void> {
  try {
    await mkdir(RUNS_DIR, { recursive: true })
    await writeFile(
      join(RUNS_DIR, `${run.projectName}.json`),
      JSON.stringify(run, null, 2)
    )
  } catch (err) {
    console.error('[orchestrate] Failed to save run state:', err)
  }
}

/**
 * Load run state from disk
 */
async function loadRunState(projectName: string): Promise<ActiveRun | null> {
  try {
    const data = await readFile(join(RUNS_DIR, `${projectName}.json`), 'utf-8')
    return JSON.parse(data)
  } catch {
    return null
  }
}

/**
 * Get or create active run for a project
 */
async function getOrCreateRun(
  projectName: string,
  projectPath: string,
  dashboardPath: string,
  phases: PhaseInfo[]
): Promise<ActiveRun> {
  // Check in-memory first
  let run = activeProjectRuns.get(projectName)
  
  if (!run) {
    // Try loading from disk
    run = await loadRunState(projectName) || undefined
  }
  
  if (!run || run.status === 'completed' || run.status === 'failed') {
    // Create new run
    run = {
      runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      projectName,
      projectPath,
      dashboardPath,
      currentPhaseNumber: phases.find(p => p.status !== 'completed')?.number || 1,
      phases,
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    console.log(`[orchestrate] Created new run ${run.runId} for project ${projectName}`)
  } else {
    // Update phases from current progress.md
    run.phases = phases
    console.log(`[orchestrate] Resuming run ${run.runId} for project ${projectName}`)
  }
  
  activeProjectRuns.set(projectName, run)
  await saveRunState(run)
  
  return run
}

export default defineEventHandler(async (event) => {
  requireAuth(event)
  const config = useRuntimeConfig(event)
  const name = validateProjectName(getRouterParam(event, 'name'))
  
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'Project name required' })
  }

  const body = await readBody<OrchestrateRequest>(event)
  const projectPath = join(config.projectsDir, name)
  const dashboardPath = DASHBOARD_PATH
  
  // Read progress.md and parse task graph
  const progressPath = join(projectPath, 'progress.md')
  let progressContent: string
  try {
    progressContent = await readFile(progressPath, 'utf-8')
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'progress.md not found' })
  }
  
  const graph = parseTaskGraph(progressContent)
  
  // Parse phases from progress.md
  const phases = parsePhases(progressContent, graph)
  
  // Check if all phases are complete
  const allPhasesComplete = phases.every(p => p.status === 'completed')
  if (allPhasesComplete) {
    return {
      status: 'complete',
      message: 'All phases complete!',
      totalTasks: graph.tasks.size,
      completedTasks: Array.from(graph.tasks.values()).filter(t => t.done).length,
      phases: phases.map(p => ({ number: p.number, name: p.name, status: p.status })),
    }
  }
  
  // Get or create active run
  const run = await getOrCreateRun(name, projectPath, dashboardPath, phases)
  
  // Find current phase to work on
  const currentPhase = getCurrentPhase(phases)
  if (!currentPhase) {
    return {
      status: 'blocked',
      message: 'No phase ready to run',
      totalTasks: graph.tasks.size,
      completedTasks: Array.from(graph.tasks.values()).filter(t => t.done).length,
      phases: phases.map(p => ({ number: p.number, name: p.name, status: p.status })),
    }
  }
  
  // Get ready tasks within the current phase
  const readyTasks = getPhaseReadyTasks(currentPhase, graph)
  
  if (readyTasks.length === 0) {
    // Check if phase is complete (all tasks done)
    const phaseComplete = currentPhase.tasks.every(t => t.done)
    
    if (phaseComplete) {
      // Phase complete - trigger merge and review
      console.log(`[orchestrate] Phase ${currentPhase.number} complete, triggering merge...`)
      
      run.status = 'merging'
      await saveRunState(run)
      
      // Trigger phase merge with review
      const mergeResult = await mergePhaseWithReview({
        runId: run.runId,
        phaseNumber: currentPhase.number,
        phaseName: currentPhase.name,
        projectContext: `Project: ${name}\nPhase: ${currentPhase.name}`,
      })
      
      if (mergeResult.success) {
        console.log(`[orchestrate] Phase ${currentPhase.number} merged successfully`)
        
        // Log activity
        const activityFile = join(projectPath, 'activity.jsonl')
        const mergeEvent = {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          type: 'phase-merge',
          message: `Phase ${currentPhase.number} merged: ${mergeResult.mergedBranches.length} branches`,
          agent: 'orchestrator',
          phaseNumber: currentPhase.number,
          phaseName: currentPhase.name,
          mergedBranches: mergeResult.mergedBranches,
          reviewerSession: mergeResult.reviewerSession,
        }
        await appendFile(activityFile, JSON.stringify(mergeEvent) + '\n')
        broadcastProjectUpdate(name, 'activity.jsonl')
        
        run.status = mergeResult.reviewerSession ? 'reviewing' : 'running'
        run.currentPhaseNumber = currentPhase.number + 1
        await saveRunState(run)
        
        return {
          status: 'phase-merged',
          message: `Phase ${currentPhase.number} merged, ${mergeResult.reviewerSession ? 'review in progress' : 'advancing to next phase'}`,
          phaseNumber: currentPhase.number,
          phaseName: currentPhase.name,
          mergedBranches: mergeResult.mergedBranches,
          reviewerSession: mergeResult.reviewerSession,
        }
      } else if (mergeResult.status === 'conflict') {
        console.log(`[orchestrate] Phase ${currentPhase.number} has conflicts, resolver spawned`)
        
        // Log conflict activity
        const activityFile = join(projectPath, 'activity.jsonl')
        const conflictEvent = {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          type: 'phase-conflict',
          message: `Phase ${currentPhase.number} has merge conflicts: ${mergeResult.conflictInfo?.conflictFiles.join(', ')}`,
          agent: 'orchestrator',
          phaseNumber: currentPhase.number,
          conflictInfo: mergeResult.conflictInfo,
          resolverSession: mergeResult.resolverSession,
        }
        await appendFile(activityFile, JSON.stringify(conflictEvent) + '\n')
        broadcastProjectUpdate(name, 'activity.jsonl')
        
        return {
          status: 'conflict',
          message: `Phase ${currentPhase.number} has merge conflicts`,
          phaseNumber: currentPhase.number,
          conflictInfo: mergeResult.conflictInfo,
          resolverSession: mergeResult.resolverSession,
        }
      } else {
        // Merge failed
        run.status = 'failed'
        await saveRunState(run)
        
        return {
          status: 'error',
          message: `Phase ${currentPhase.number} merge failed: ${mergeResult.error}`,
          error: mergeResult.error,
        }
      }
    }
    
    // No ready tasks but phase not complete - blocked by dependencies
    return {
      status: 'blocked',
      message: `Phase ${currentPhase.number} blocked - waiting for task dependencies`,
      currentPhase: currentPhase.number,
      phaseName: currentPhase.name,
      totalTasks: graph.tasks.size,
      completedTasks: Array.from(graph.tasks.values()).filter(t => t.done).length,
    }
  }
  
  // Initialize phase tracking if not already done
  const existingPhaseState = await getPhaseState(run.runId, currentPhase.number)
  if (!existingPhaseState) {
    await initPhase({
      runId: run.runId,
      phaseNumber: currentPhase.number,
      repoDir: dashboardPath,
      baseBranch: 'main',
      workerIds: readyTasks.map(t => t.id),
      taskIds: readyTasks.map(t => t.id),
      projectPath,  // Pass project path for phase advancement
      projectName: name,  // Pass project name for API calls
    })
    console.log(`[orchestrate] Initialized phase ${currentPhase.number} tracking with ${readyTasks.length} workers`)
  }
  
  // Spawn workers for ready tasks in the current phase
  // STAGGERED PARALLEL: Spawn all tasks but with delays between each to avoid overwhelming gateway
  const spawned: { taskId: string; workerId: string; workerBranch?: string; escalationId?: string }[] = []
  const SPAWN_DELAY_MS = 3000 // 3 seconds between spawns
  
  // Filter out tasks that already have running workers (deduplication)
  const { spawnable: spawnableTasks, skipped: skippedTasks } = await filterSpawnableTasks(name, readyTasks)
  
  if (skippedTasks.length > 0) {
    console.log(`[orchestrate] Skipping ${skippedTasks.length} tasks already running:`, skippedTasks.map(s => s.task.id))
  }
  
  // Filter out tasks with exhausted retry states (require human intervention)
  const tasksToSpawn: typeof spawnableTasks = []
  const exhaustedTasks: { task: typeof spawnableTasks[0]; escalationId?: string }[] = []
  
  for (const task of spawnableTasks) {
    const taskStepOrder = currentPhase.number * 100000 + hashTaskId(task.id)
    const retryState = await getRetryState(run.runId, taskStepOrder)
    
    if (retryState?.status === 'exhausted') {
      console.log(`[orchestrate] Task ${task.id} exhausted retries, skipping (requires human intervention)`)
      exhaustedTasks.push({ task })
    } else {
      tasksToSpawn.push(task)
    }
  }
  
  if (exhaustedTasks.length > 0) {
    console.log(`[orchestrate] ${exhaustedTasks.length} tasks require human intervention:`, exhaustedTasks.map(e => e.task.id))
  }
  
  if (tasksToSpawn.length > 1) {
    console.log(`[orchestrate] Staggered parallel: spawning ${tasksToSpawn.length} tasks with ${SPAWN_DELAY_MS}ms delays`)
  }
  
  for (let i = 0; i < tasksToSpawn.length; i++) {
    const task = tasksToSpawn[i]
    
    // Add delay between spawns (not before first one)
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, SPAWN_DELAY_MS))
    }
    const workerId = randomUUID()
    
    // Create worktree for isolated work
    let worktreePath: string | undefined
    let workerBranch: string | undefined
    
    const worktreeResult = await createWorktree({
      repoDir: dashboardPath,
      runId: run.runId,
      workerId: task.id,
      baseBranch: 'main',
    })
    
    if (worktreeResult.ok && worktreeResult.worktree) {
      worktreePath = worktreeResult.worktree.path
      workerBranch = worktreeResult.worktree.branch
      console.log(`[orchestrate] Created worktree for task ${task.id}: ${worktreePath} (branch: ${workerBranch})`)
    } else {
      console.warn(`[orchestrate] Failed to create worktree for task ${task.id}: ${worktreeResult.error}`)
      console.warn(`[orchestrate] Worker will work directly in ${dashboardPath}`)
    }
    
    const prompt = await buildWorkerPrompt({
      task,
      projectName: name,
      projectPath,
      dashboardPath,
      runId: run.runId,
      phaseNumber: currentPhase.number,
      worktreePath,
      workerBranch,
    })
    
    try {
      await wakeAgent(prompt, `swarm:${name}:${task.id}`)
      
      // Register task in task-registry for deduplication
      await registerTask({
        projectName: name,
        taskId: task.id,
        runId: run.runId,
        phaseNumber: currentPhase.number,
        workerId,
        workerBranch,
      })
      
      // Register worker
      await updateWorkersRegistry({
        id: workerId,
        roleId: task.role,
        roleName: task.role === 'reviewer' ? 'Reviewer' : 'Builder',
        taskId: task.id,
        taskName: task.title,
        projectName: name,
        status: 'running',
        startedAt: new Date().toISOString()
      })
      
      spawned.push({ taskId: task.id, workerId, workerBranch })
      
      // Log to activity
      const activityFile = join(projectPath, 'activity.jsonl')
      const spawnEvent = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        type: 'spawn',
        message: `${task.role === 'reviewer' ? 'Reviewer' : 'Builder'} spawned: ${task.title}${workerBranch ? ` (branch: ${workerBranch})` : ''}`,
        agent: 'orchestrator',
        runId: run.runId,
        phaseNumber: currentPhase.number,
        taskId: task.id,
        workerId,
        worktreePath,
        workerBranch,
      }
      await appendFile(activityFile, JSON.stringify(spawnEvent) + '\n')
      broadcastProjectUpdate(name, 'activity.jsonl')
      
    } catch (err: any) {
      console.error(`[orchestrate] Failed to spawn worker for ${task.id}:`, err)
      
      // Handle spawn failure with retry logic
      try {
        const retryResult = await handleWorkerSpawnFailure({
          task,
          runId: run.runId,
          phaseNumber: currentPhase.number,
          projectName: name,
          projectPath,
          dashboardPath,
          error: err?.message || String(err),
        })
        
        if (retryResult.escalationId) {
          // Task was escalated - log it in the spawned results
          spawned.push({ 
            taskId: task.id, 
            workerId: 'escalated',
            escalationId: retryResult.escalationId,
          })
        }
        // If willRetry is true, the retry is scheduled and will re-trigger orchestrate
      } catch (retryErr) {
        console.error(`[orchestrate] Failed to handle spawn failure:`, retryErr)
      }
    }
  }
  
  run.status = 'running'
  run.currentPhaseNumber = currentPhase.number
  await saveRunState(run)
  
  return {
    status: 'running',
    message: `Spawned ${spawned.length} workers for Phase ${currentPhase.number}: ${currentPhase.name}`,
    runId: run.runId,
    currentPhase: currentPhase.number,
    phaseName: currentPhase.name,
    spawned,
    totalTasks: graph.tasks.size,
    completedTasks: Array.from(graph.tasks.values()).filter(t => t.done).length,
    readyTasks: readyTasks.map(t => ({ id: t.id, title: t.title, role: t.role })),
    phases: phases.map(p => ({ number: p.number, name: p.name, status: p.status, taskCount: p.tasks.length })),
  }
})

/**
 * Get active run for a project (exported for use by other modules)
 */
export function getActiveRun(projectName: string): ActiveRun | undefined {
  return activeProjectRuns.get(projectName)
}

/**
 * Update active run (exported for use by task-complete endpoint)
 */
export async function updateActiveRun(projectName: string, updates: Partial<ActiveRun>): Promise<void> {
  const run = activeProjectRuns.get(projectName)
  if (run) {
    Object.assign(run, updates)
    await saveRunState(run)
  }
}
