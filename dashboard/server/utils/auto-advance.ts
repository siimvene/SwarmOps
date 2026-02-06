import { DASHBOARD_PATH, SKILLS_DIR } from '~/server/utils/paths'
import { readFile, writeFile, appendFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import type { ProjectState, ProjectPhase } from '../types/project'
import { parseTaskGraph, getReadyTasks } from './orchestrator'
import { getRoleConfig } from './role-loader'
import { wakeAgent, buildBuilderPrompt } from './agent'
import { broadcastProjectUpdate } from '../plugins/websocket'
import { createWorktree } from './worktree-manager'
import { filterSpawnableTasks, registerTask, updateTaskStatus } from './task-registry'

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

export async function logActivity(
  projectPath: string, 
  projectName: string, 
  type: string, 
  message: string, 
  extra: Record<string, any> = {}
) {
  const activityFile = join(projectPath, 'activity.jsonl')
  const event = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    message,
    agent: 'auto-advance',
    ...extra
  }
  await appendFile(activityFile, JSON.stringify(event) + '\n')
  broadcastProjectUpdate(projectName, 'activity.jsonl')
}

export async function updateProjectPhase(
  projectPath: string,
  projectName: string,
  newPhase: ProjectPhase,
  newStatus: 'pending' | 'running' | 'completed' = 'running'
): Promise<ProjectState> {
  const statePath = join(projectPath, 'state.json')
  
  let state: ProjectState
  try {
    const stateRaw = await readFile(statePath, 'utf-8')
    state = JSON.parse(stateRaw)
  } catch {
    state = {
      project: projectName,
      phase: 'interview',
      iteration: 0,
      status: 'pending',
      startedAt: new Date().toISOString(),
      history: []
    }
  }
  
  const oldPhase = state.phase
  state.phase = newPhase
  state.status = newStatus
  state.iteration = 0
  state.history = state.history || []
  state.history.push({
    iteration: 0,
    timestamp: new Date().toISOString()
  })
  
  if (newPhase === 'complete') {
    state.completedAt = new Date().toISOString()
  }
  
  await writeFile(statePath, JSON.stringify(state, null, 2))
  broadcastProjectUpdate(projectName, 'state.json')
  
  // Only log phase change if phase actually changed
  if (oldPhase !== newPhase) {
    await logActivity(projectPath, projectName, 'phase-change', 
      `Auto-advanced: ${oldPhase} → ${newPhase}`)
  }
  
  return state
}

export async function checkAndAdvancePhase(
  projectPath: string,
  projectName: string,
  config: { projectsDir: string }
): Promise<{ advanced: boolean; newPhase?: ProjectPhase; message: string }> {
  const statePath = join(projectPath, 'state.json')
  
  let state: ProjectState
  try {
    const stateRaw = await readFile(statePath, 'utf-8')
    state = JSON.parse(stateRaw)
  } catch {
    return { advanced: false, message: 'Could not read project state' }
  }
  
  // Based on current phase, check if we should advance
  switch (state.phase) {
    case 'interview': {
      // Check if interview is complete
      const interviewPath = join(projectPath, 'interview.json')
      try {
        const interviewData = await readFile(interviewPath, 'utf-8')
        const interview = JSON.parse(interviewData)
        if (interview.complete) {
          // Interview done → advance to spec
          await updateProjectPhase(projectPath, projectName, 'spec')
          return { advanced: true, newPhase: 'spec', message: 'Interview complete, advancing to spec phase' }
        }
      } catch {}
      return { advanced: false, message: 'Interview not yet complete' }
    }
    
    case 'spec': {
      // Check if spec/plan exists
      const planPath = join(projectPath, 'specs', 'IMPLEMENTATION_PLAN.md')
      try {
        await readFile(planPath, 'utf-8')
        // Plan exists → advance to build
        await updateProjectPhase(projectPath, projectName, 'build')
        return { advanced: true, newPhase: 'build', message: 'Spec complete, advancing to build phase' }
      } catch {}
      return { advanced: false, message: 'Spec/plan not yet complete' }
    }
    
    case 'build': {
      // Check if all build tasks are done
      const progressPath = join(projectPath, 'progress.md')
      try {
        const progressContent = await readFile(progressPath, 'utf-8')
        const graph = parseTaskGraph(progressContent)
        const allDone = Array.from(graph.tasks.values()).every(t => t.done)
        
        if (allDone && graph.tasks.size > 0) {
          // All tasks done → advance to review
          await updateProjectPhase(projectPath, projectName, 'review')
          return { advanced: true, newPhase: 'review', message: 'All build tasks complete, advancing to review' }
        }
      } catch {}
      return { advanced: false, message: 'Build tasks not yet complete' }
    }
    
    case 'review': {
      // Check if all tasks (including review) are done
      const progressPath = join(projectPath, 'progress.md')
      try {
        const progressContent = await readFile(progressPath, 'utf-8')
        const graph = parseTaskGraph(progressContent)
        const allDone = Array.from(graph.tasks.values()).every(t => t.done)
        
        if (allDone && graph.tasks.size > 0) {
          // All tasks including review done → project complete!
          await updateProjectPhase(projectPath, projectName, 'complete', 'completed')
          return { advanced: true, newPhase: 'complete', message: 'All tasks complete, project finished!' }
        }
      } catch {}
      return { advanced: false, message: 'Review tasks not yet complete' }
    }
    
    default:
      return { advanced: false, message: `Already at terminal phase: ${state.phase}` }
  }
}

// Track active phase work to prevent duplicate spawns
const activePhaseWork = new Map<string, number>()
const PHASE_WORK_COOLDOWN_MS = 30000 // 30 second cooldown for build tasks
const SPEC_PHASE_COOLDOWN_MS = 5 * 60 * 1000 // 5 minute cooldown for spec phase (longer running)

export async function triggerPhaseWork(
  projectPath: string,
  projectName: string,
  phase: ProjectPhase
): Promise<{ triggered: boolean; message: string; details?: any }> {
  // Deduplication: prevent spawning same project+phase within cooldown
  const key = `${projectName}:${phase}`
  const lastTriggered = activePhaseWork.get(key)
  const now = Date.now()
  
  // Use longer cooldown for spec phase (5 min) vs build tasks (30s)
  const cooldownMs = phase === 'spec' ? SPEC_PHASE_COOLDOWN_MS : PHASE_WORK_COOLDOWN_MS
  
  if (lastTriggered && (now - lastTriggered) < cooldownMs) {
    console.log(`[triggerPhaseWork] Skipping ${key} - within cooldown (${Math.round((cooldownMs - (now - lastTriggered)) / 1000)}s remaining)`)
    return { triggered: false, message: `Phase work for ${phase} already triggered recently, skipping duplicate` }
  }
  
  // Mark as triggered
  activePhaseWork.set(key, now)
  console.log(`[triggerPhaseWork] Starting ${key}`)
  
  const dashboardPath = DASHBOARD_PATH
  
  switch (phase) {
    case 'spec': {
      // Use architect role to design solution, then task-decomposer to break into tasks
      const interviewPath = join(projectPath, 'interview.json')
      let interviewContent = ''
      try {
        const data = await readFile(interviewPath, 'utf-8')
        const interview = JSON.parse(data)
        interviewContent = interview.messages
          ?.map((m: any) => `${m.role.toUpperCase()}: ${m.content}`)
          .join('\n\n') || ''
      } catch {}

      // Load architect + task-decomposer role configs
      const architectRole = await getRoleConfig('architect')
      const decomposerRole = await getRoleConfig('task-decomposer')

      const specPrompt = `[SWARMOPS SPEC PHASE] Project: ${projectName}

## Your Roles (Combined)

### 1. Architect
${architectRole.instructions || 'Design the solution architecture.'}

### 2. Task Decomposer  
${decomposerRole.instructions || 'Break down into atomic tasks.'}

---

## Context

**Project Path:** ${projectPath}
**Dashboard Path:** ${dashboardPath}

### Interview Summary
${interviewContent || 'No interview data available'}

## Your Task

You are handling the SPEC phase. This means:

1. **Architect** the solution: analyze requirements, design component structure, define interfaces
2. **Decompose** into tasks: create a detailed implementation plan with annotated tasks

### Output Required

Create \`${projectPath}/specs/IMPLEMENTATION_PLAN.md\` with:
- Architecture overview
- Component breakdown
- Task list using this format:

\`\`\`markdown
## Tasks

- [ ] Task description @id(task-id) @role(builder)
- [ ] Another task @id(task-2) @depends(task-id) @role(builder)
- [ ] Security review @id(sec-review) @depends(task-id,task-2) @role(security-reviewer)
- [ ] Code review @id(review) @depends(task-id,task-2) @role(reviewer)
\`\`\`

**Available @role() values:** builder, reviewer, security-reviewer, designer

Then update \`${projectPath}/progress.md\` with the task list.

### Signal Completion

\`\`\`bash
curl -X POST http://localhost:3939/api/projects/${projectName}/spec-complete \\
  -H "Content-Type: application/json" \\
  -d '{"summary": "Brief description of what was planned"}'
\`\`\`

Begin now.`

      try {
        const { spawnSession } = await import('./gateway-client')
        const result = await spawnSession({
          task: specPrompt,
          label: `swarm:${projectName}:spec-phase`,
          model: architectRole.model,
          thinking: architectRole.thinking,
          cleanup: 'keep',
        })
        if (!result.ok) {
          throw new Error(result.error?.message || 'Spawn failed')
        }
        await logActivity(projectPath, projectName, 'spawn', 
          `Spec phase agent spawned (architect: ${architectRole.model}, thinking: ${architectRole.thinking})`)
        return { triggered: true, message: 'Spec phase agent spawned with architect + task-decomposer roles' }
      } catch (err) {
        return { triggered: false, message: `Failed to spawn spec agent: ${err}` }
      }
    }
    
    case 'build': {
      // Start the orchestrator (spawns parallel builders)
      return await triggerOrchestrator(projectPath, projectName)
    }
    
    case 'review': {
      // Trigger sequential review chain: reviewer -> security-reviewer -> designer (conditional)
      try {
        const { startReviewChain } = await import('./phase-reviewer')
        const chainResult = await startReviewChain({
          projectName,
          projectPath,
          dashboardPath,
        })
        if (chainResult.ok) {
          await logActivity(projectPath, projectName, 'spawn',
            `Review chain started: ${chainResult.chain?.join(' → ')}`)
          return { triggered: true, message: `Review chain started: ${chainResult.chain?.join(' → ')}` }
        } else {
          return { triggered: false, message: `Failed to start review chain: ${chainResult.error}` }
        }
      } catch (err) {
        return { triggered: false, message: `Failed to start review chain: ${err}` }
      }
    }
    
    default:
      return { triggered: false, message: `No work to trigger for phase: ${phase}` }
  }
}

export async function triggerOrchestrator(
  projectPath: string,
  projectName: string
): Promise<{ triggered: boolean; message: string; details?: any }> {
  const progressPath = join(projectPath, 'progress.md')
  const dashboardPath = DASHBOARD_PATH
  
  let progressContent: string
  try {
    progressContent = await readFile(progressPath, 'utf-8')
  } catch {
    return { triggered: false, message: 'progress.md not found' }
  }
  
  const graph = parseTaskGraph(progressContent)
  const readyTasks = getReadyTasks(graph)
  
  if (readyTasks.length === 0) {
    const allDone = Array.from(graph.tasks.values()).every(t => t.done)
    if (allDone) {
      // All done → trigger review phase
      const advanceResult = await checkAndAdvancePhase(projectPath, projectName, { projectsDir: '' })
      if (advanceResult.advanced && advanceResult.newPhase) {
        const triggerResult = await triggerPhaseWork(projectPath, projectName, advanceResult.newPhase)
        return { 
          triggered: triggerResult.triggered, 
          message: `All tasks complete. ${advanceResult.message}. ${triggerResult.message}`,
          details: { allTasksDone: true, nextPhase: advanceResult.newPhase }
        }
      }
    }
    return { triggered: false, message: 'No ready tasks (all done or blocked)', details: { allDone } }
  }
  
  // Spawn workers for ready tasks
  // STAGGERED PARALLEL: Spawn all tasks but with delays between each
  const spawned: string[] = []
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const SPAWN_DELAY_MS = 3000 // 3 seconds between spawns
  
  // Filter out tasks that already have running workers (deduplication)
  const { spawnable: tasksToSpawn, skipped: skippedTasks } = await filterSpawnableTasks(projectName, readyTasks)
  
  if (skippedTasks.length > 0) {
    console.log(`[auto-advance] Skipping ${skippedTasks.length} tasks already running:`, skippedTasks.map(s => s.task.id))
  }
  
  if (tasksToSpawn.length > 1) {
    console.log(`[auto-advance] Staggered parallel: spawning ${tasksToSpawn.length} tasks with ${SPAWN_DELAY_MS}ms delays`)
  }
  
  for (let i = 0; i < tasksToSpawn.length; i++) {
    const task = tasksToSpawn[i]
    
    // Add delay between spawns (not before first one)
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, SPAWN_DELAY_MS))
    }
    // Create worktree for isolated work
    let worktreePath: string | undefined
    let workerBranch: string | undefined
    
    const worktreeResult = await createWorktree({
      repoDir: dashboardPath, // Use dashboard as the repo for worktree
      runId,
      workerId: task.id,
      baseBranch: 'main',
    })
    
    if (worktreeResult.ok && worktreeResult.worktree) {
      worktreePath = worktreeResult.worktree.path
      workerBranch = worktreeResult.worktree.branch
      console.log(`[worktree] Created worktree for task ${task.id}: ${worktreePath} (branch: ${workerBranch})`)
    } else {
      console.warn(`[worktree] Failed to create worktree for task ${task.id}: ${worktreeResult.error}`)
      console.warn(`[worktree] Worker will work directly in ${dashboardPath}`)
    }
    
    const prompt = await buildWorkerPrompt({
      task,
      projectName,
      projectPath,
      dashboardPath,
      worktreePath,
      workerBranch,
    })
    
    const workerId = randomUUID()
    
    // Register task BEFORE spawning to prevent race conditions
    // If spawn fails, we'll update the status to failed
    await registerTask({
      projectName,
      taskId: task.id,
      runId,
      workerBranch,
      workerId,
    })
    
    try {
      const taskRole = await getRoleConfig(task.role || 'builder')
      
      // Use role's model/thinking from roles.json
      const { spawnSession } = await import('./gateway-client')
      const spawnResult = await spawnSession({
        task: prompt,
        label: `swarm:${projectName}:${task.id}`,
        model: taskRole.model,
        thinking: taskRole.thinking,
        cleanup: 'keep',
      })
      if (!spawnResult.ok) {
        throw new Error(spawnResult.error?.message || 'Spawn failed')
      }
      
      // Update workers registry so workers page shows active workers
      await updateWorkersRegistry({
        id: workerId,
        roleId: task.role || 'builder',
        roleName: task.role === 'reviewer' ? 'Reviewer' : 'Builder',
        taskId: task.id,
        taskName: task.title,
        projectName,
        status: 'running',
        startedAt: new Date().toISOString()
      })
      
      spawned.push(task.id)
      
      await logActivity(projectPath, projectName, 'spawn', 
        `Builder spawned: ${task.title}${workerBranch ? ` (branch: ${workerBranch})` : ''}`, 
        { taskId: task.id, workerId, worktreePath, workerBranch })
    } catch (err) {
      console.error(`Failed to spawn worker for ${task.id}:`, err)
      // Mark task as failed in registry so it can be retried
      await updateTaskStatus({
        projectName,
        taskId: task.id,
        status: 'failed',
        error: String(err),
      })
    }
  }
  
  return { 
    triggered: spawned.length > 0, 
    message: `Spawned ${spawned.length} workers for ready tasks`,
    details: { spawned, readyTasks: readyTasks.map(t => t.id) }
  }
}

interface WorkerPromptOpts {
  task: any
  projectName: string
  projectPath: string
  dashboardPath: string
  worktreePath?: string
  workerBranch?: string
}

// Web design keywords that trigger the web-visuals skill
const WEB_DESIGN_KEYWORDS = [
  'html', 'css', 'landing', 'website', 'webpage', 'web page', 'hero', 
  'ui', 'interface', 'design', 'styling', 'layout', 'beautiful', 
  'modern', 'responsive', 'frontend', 'front-end', 'visual'
]

function isWebDesignTask(task: any, projectName: string): boolean {
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
  const { task, projectName, projectPath, dashboardPath, worktreePath, workerBranch } = opts
  const workDir = worktreePath || dashboardPath
  
  if (task.role === 'reviewer' || task.role === 'security-reviewer') {
    return `[SWARMOPS REVIEWER] Project: ${projectName}
Task: ${task.title}
Task ID: ${task.id}

You are a senior code reviewer.

**Working Directory:** ${workDir}
**Project Path:** ${projectPath}
**Dashboard Path:** ${dashboardPath}
${workerBranch ? `**Branch:** ${workerBranch}\n\nYou are working in an isolated git worktree.` : ''}

Review the code, check for bugs, then post results:

\`\`\`bash
curl -X POST http://localhost:3939/api/projects/${projectName}/review-result \\
  -H "Content-Type: application/json" \\
  -d '{"status": "approved"}' # or "request_changes" with findings
\`\`\`

Then mark the review task done in progress.md.`
  }
  
  const commitInstructions = workerBranch
    ? `2. Commit your changes with a clear commit message (you're on branch \`${workerBranch}\`)
3. Update progress.md - change [ ] to [x] for your task
4. Call the task-complete endpoint to continue the build:`
    : `2. When done, update progress.md - change [ ] to [x] for your task
3. Call the task-complete endpoint to continue the build:`
  
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
      console.log(`[auto-advance] Web design skill injected for task: ${task.id}`)
    }
  }
  
  return `[SWARMOPS BUILDER] Project: ${projectName}
Task: ${task.title}
Task ID: ${task.id}

**Working Directory:** ${workDir}
**Project Path:** ${projectPath}
**Dashboard Path:** ${dashboardPath}
${workerBranch ? `**Branch:** ${workerBranch}\n\nYou are working in an isolated git worktree. Make your changes and commit them before completing.` : ''}
${webDesignSkill}
## Instructions
1. Implement: ${task.title}
${commitInstructions}

\`\`\`bash
curl -X POST http://localhost:3939/api/projects/${projectName}/task-complete \\
  -H "Content-Type: application/json" \\
  -d '{"taskId": "${task.id}"}'
\`\`\`

Focus ONLY on this task.`
}
