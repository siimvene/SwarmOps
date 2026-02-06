import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

export async function getGatewayUrl(): Promise<string> {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json')
  try {
    const configData = await readFile(configPath, 'utf-8')
    const config = JSON.parse(configData)
    const port = config.gateway?.port || 18789
    return `http://localhost:${port}`
  } catch {
    return 'http://localhost:18789'
  }
}

export async function wakeAgent(text: string, label?: string): Promise<any> {
  // Use gateway's sessions_spawn via tools/invoke endpoint
  const { spawnSession } = await import('./gateway-client')
  
  const result = await spawnSession({
    task: text,
    label: label || 'swarm-agent',
    runTimeoutSeconds: 600, // 10 minutes for actual work
    cleanup: 'keep',
    skipVerify: false, // Verify sessions actually start (fixed 2026-02-03)
  })
  
  if (!result.ok) {
    console.error(`[wakeAgent] Spawn failed: ${result.error?.message}`)
    throw new Error(result.error?.message || 'Spawn failed')
  }
  
  console.log(`[wakeAgent] Session spawned: ${result.result?.childSessionKey} (verified: ${result.verified})`)
  
  return {
    success: result.ok,
    method: 'sessions_spawn',
    runId: result.result?.runId,
    sessionKey: result.result?.childSessionKey,
    verified: result.verified,
  }
}

export function buildInterviewPrompt(projectName: string, goal: string): string {
  return `[SWARMOPS INTERVIEW] Project: ${projectName}

You are conducting an interview for a new SwarmOps project.

**Project Goal:**
${goal}

**Your Task:**
1. The user has already provided their goal above
2. Ask 2-3 clarifying questions to understand scope, constraints, and success criteria
3. Keep questions concise and focused
4. When you have enough info, generate an implementation plan

**To respond in the interview chat, use:**
\`\`\`
curl -X POST http://localhost:3939/api/projects/${projectName}/interview \\
  -H "Content-Type: application/json" \\
  -d '{"role": "agent", "content": "YOUR MESSAGE HERE"}'
\`\`\`

**To complete the interview and generate plan:**

When you have enough information, send a friendly closing message and mark complete:
\`\`\`
curl -X POST http://localhost:3939/api/projects/${projectName}/interview \\
  -H "Content-Type: application/json" \\
  -d '{"role": "agent", "content": "Thanks! I think I have everything I need to put together a solid plan. Give me a moment to draft the implementation...", "complete": true}'
\`\`\`

Start by acknowledging the goal and asking your first clarifying question.`
}

export function buildPlannerPrompt(projectName: string, interviewMessages: any[], projectPath?: string): string {
  const conversation = interviewMessages
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n')
  
  const basePath = projectPath || `./projects/${projectName}`
  
  return `[SWARMOPS PLANNER] Project: ${projectName}

Based on this interview, create an implementation plan:

${conversation}

**Your Task:**
1. Create a detailed implementation plan in \`${basePath}/specs/IMPLEMENTATION_PLAN.md\`
2. Break work into phases with clear tasks
3. Update state.json to phase: "build", status: "ready"
4. Post a summary to the activity feed

**To update state:**
\`\`\`
echo '{"project":"${projectName}","phase":"build","iteration":0,"status":"ready","startedAt":"'$(date -Iseconds)'","history":[{"phase":"interview","completedAt":"'$(date -Iseconds)'"},{"phase":"planning","completedAt":"'$(date -Iseconds)'"}]}' > ${basePath}/state.json
\`\`\`

Create the plan now.`
}

export interface BuilderPromptOpts {
  projectName: string
  projectPath: string
  worktreePath?: string
  workerBranch?: string
  taskId?: string
  taskDescription?: string
}

export function buildBuilderPrompt(projectName: string, projectPath: string, opts?: Partial<BuilderPromptOpts>): string {
  const workDir = opts?.worktreePath || projectPath
  const hasWorktree = opts?.worktreePath && opts?.workerBranch
  
  const lines = [
    `[SWARMOPS BUILDER] Project: ${projectName}`,
    '',
    'You are a builder working on this project.',
    '',
  ]
  
  if (hasWorktree) {
    lines.push('## Working Environment')
    lines.push('')
    lines.push('You are working in an **isolated git worktree** for parallel development:')
    lines.push('')
    lines.push(`- **Worktree Path:** \`${opts!.worktreePath}\``)
    lines.push(`- **Branch:** \`${opts!.workerBranch}\``)
    lines.push(`- **Original Project:** \`${projectPath}\``)
    lines.push('')
    lines.push('> ⚠️ **IMPORTANT:** All your file operations must use the worktree path above.')
  } else {
    lines.push(`**Project Path:** ${projectPath}`)
  }
  
  if (opts?.taskId && opts?.taskDescription) {
    lines.push('')
    lines.push('## Assigned Task')
    lines.push('')
    lines.push(`**Task ID:** \`${opts.taskId}\``)
    lines.push(`**Description:** ${opts.taskDescription}`)
  }
  
  lines.push('')
  lines.push('## Your Task')
  lines.push('')
  lines.push('1. Read `progress.md` and `specs/IMPLEMENTATION_PLAN.md`')
  
  if (opts?.taskId) {
    lines.push('2. Implement the assigned task above')
  } else {
    lines.push('2. Find the next incomplete task (unchecked item)')
    lines.push('3. Implement it')
  }
  
  if (hasWorktree) {
    lines.push(`${opts?.taskId ? '3' : '4'}. Commit your changes:`)
    lines.push('   ```bash')
    lines.push(`   cd ${opts!.worktreePath}`)
    lines.push('   git add -A')
    lines.push(`   git commit -m "${opts?.taskId || 'task'}: [describe what you did]"`)
    lines.push('   ```')
    lines.push(`${opts?.taskId ? '4' : '5'}. Update progress.md marking the task complete`)
    lines.push(`${opts?.taskId ? '5' : '6'}. Report what you did`)
  } else {
    lines.push(`${opts?.taskId ? '3' : '4'}. Update progress.md marking the task complete`)
    lines.push(`${opts?.taskId ? '4' : '5'}. Report what you did`)
  }
  
  lines.push('')
  lines.push('Work on ONE task at a time. When done, the orchestrator will spawn you again for the next task.')
  lines.push('')
  lines.push('---')
  lines.push(`Remember: Your working directory is \`${workDir}\``)

  return lines.join('\n')
}
