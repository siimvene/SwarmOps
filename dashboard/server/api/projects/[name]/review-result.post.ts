import { DASHBOARD_PATH } from '~/server/utils/paths'
import { appendFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { wakeAgent } from '../../../utils/agent'
import { broadcastProjectUpdate } from '../../../plugins/websocket'
import { updateProjectPhase, logActivity, triggerOrchestrator } from '../../../utils/auto-advance'
import { getPhaseState } from '../../../utils/phase-collector'
import { handleApproval, handleFixRequest, handleEscalation } from '../../../utils/review-handler'
import { advanceToNextPhase } from '../../../utils/phase-advancer'
import { requireAuth, validateProjectName } from '../../../utils/security'

interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low'
  file: string
  line?: number
  description: string
  fix?: string
}

interface ReviewResultRequest {
  status: 'approved' | 'request_changes'
  findings?: ReviewFinding[]
  summary?: string
  // New pipeline flow fields
  runId?: string
  phaseNumber?: number
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const name = validateProjectName(getRouterParam(event, 'name'))
  
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'Project name required' })
  }

  const body = await readBody<ReviewResultRequest>(event)
  const projectPath = join(config.projectsDir, name)
  const dashboardPath = DASHBOARD_PATH
  
  // Log review result to activity
  const activityFile = join(projectPath, 'activity.jsonl')
  const activityEvent = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type: body.status === 'approved' ? 'complete' : 'review',
    message: body.status === 'approved' 
      ? 'Review APPROVED - all checks passed'
      : `Review REQUEST_CHANGES - ${body.findings?.length || 0} issues found`,
    agent: 'reviewer',
    findings: body.findings,
    runId: body.runId,
    phaseNumber: body.phaseNumber,
  }
  await appendFile(activityFile, JSON.stringify(activityEvent) + '\n')
  broadcastProjectUpdate(name, 'activity.jsonl')
  
  // If runId and phaseNumber provided, use the new pipeline flow
  if (body.runId && body.phaseNumber !== undefined) {
    console.log(`[review-result] Using pipeline flow for run ${body.runId}, phase ${body.phaseNumber}`)
    return await handlePipelineReviewResult(body, name, projectPath, dashboardPath)
  }
  
  // Legacy flow (no runId/phaseNumber)
  console.log(`[review-result] Using legacy flow (no runId/phaseNumber)`)
  return await handleSimpleReviewResult(body, name, projectPath, dashboardPath)
})

/**
 * Handle review result using the new pipeline flow
 */
async function handlePipelineReviewResult(
  body: ReviewResultRequest,
  projectName: string,
  projectPath: string,
  dashboardPath: string
) {
  const { runId, phaseNumber, status, findings } = body
  
  // Verify phase state exists
  const phaseState = await getPhaseState(runId!, phaseNumber!)
  if (!phaseState) {
    console.warn(`[review-result] Phase state not found for run ${runId}, phase ${phaseNumber}`)
    // Fall back to legacy handling
    return await handleSimpleReviewResult(body, projectName, projectPath, dashboardPath)
  }
  
  if (status === 'approved') {
    console.log(`[review-result] Phase ${phaseNumber} APPROVED via pipeline flow`)
    
    // Handle approval - merge phase branch to main
    const approvalResult = await handleApproval({
      runId: runId!,
      phaseNumber: phaseNumber!,
      comments: body.summary,
    })
    
    if (approvalResult.success && approvalResult.merged) {
      // Log merge success
      await logActivity(projectPath, projectName, 'phase-merged', 
        `Phase ${phaseNumber} merged to main after review approval`,
        { runId, phaseNumber })
      
      // Advance to next phase
      const advanceResult = await advanceToNextPhase({
        runId: runId!,
        completedPhaseNumber: phaseNumber!,
        projectPath,
        projectName,
      })
      
      if (advanceResult.pipelineComplete) {
        // Mark project as complete
        try {
          await updateProjectPhase(projectPath, projectName, 'complete', 'completed')
          await logActivity(projectPath, projectName, 'complete', 
            'Project COMPLETED - all phases reviewed and merged!')
        } catch (err) {
          console.error('Failed to mark project complete:', err)
        }
        
        return {
          status: 'approved',
          message: 'Pipeline complete - all phases reviewed and merged',
          pipelineComplete: true,
          runId,
          phaseNumber,
        }
      }
      
      if (advanceResult.advanced) {
        return {
          status: 'approved',
          message: `Phase ${phaseNumber} merged. Advanced to phase ${advanceResult.nextPhase}`,
          nextPhase: advanceResult.nextPhase,
          spawnedWorkers: advanceResult.spawnedWorkers,
          runId,
          phaseNumber,
        }
      }
      
      return {
        status: 'approved',
        message: advanceResult.message,
        runId,
        phaseNumber,
      }
    }
    
    // Merge failed - might need to handle escalation
    return {
      status: 'error',
      message: approvalResult.error || 'Failed to merge phase branch',
      runId,
      phaseNumber,
    }
  }
  
  // Handle request_changes - ALL issues must be fixed, no auto-approval
  // If reviewer said "request_changes", respect that decision regardless of severity
  const allFindings = findings || []
  
  if (allFindings.length === 0) {
    // No specific findings but reviewer still said request_changes - escalate for clarity
    console.log(`[review-result] REQUEST_CHANGES with no findings - escalating for human review`)
    
    return {
      status: 'needs_clarification',
      message: 'Reviewer requested changes but provided no specific findings. Human review needed.',
      runId,
      phaseNumber,
    }
  }
  
  // Build fix instructions from ALL findings (not just high/critical)
  const fixNeeded = allFindings
  const fixInstructions = fixNeeded.map((f, i) => 
    `${i + 1}. [${f.severity.toUpperCase()}] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.description}${f.fix ? ` → Fix: ${f.fix}` : ''}`
  ).join('\n')
  
  console.log(`[review-result] Phase ${phaseNumber} needs fixes: ${fixNeeded.length} High/Critical issues`)
  
  // Handle fix request - spawns fixer agent with proper tracking
  const fixResult = await handleFixRequest({
    runId: runId!,
    phaseNumber: phaseNumber!,
    fixInstructions,
    reviewComments: body.summary,
  })
  
  if (fixResult.escalated) {
    await logActivity(projectPath, projectName, 'escalated',
      `Phase ${phaseNumber} escalated after max fix attempts`,
      { runId, phaseNumber, escalationId: fixResult.escalationId })
    
    return {
      status: 'escalated',
      message: fixResult.message,
      escalationId: fixResult.escalationId,
      fixNeeded,
      runId,
      phaseNumber,
    }
  }
  
  if (fixResult.success && fixResult.fixerSession) {
    await logActivity(projectPath, projectName, 'spawn',
      `Fixer agent spawned for ${fixNeeded.length} High/Critical issues`,
      { runId, phaseNumber, fixerSession: fixResult.fixerSession })
    
    return {
      status: 'fixing',
      message: fixResult.message,
      fixerSession: fixResult.fixerSession,
      fixNeeded,
      runId,
      phaseNumber,
    }
  }
  
  // Fix request failed - fall back to simple fixer
  console.warn(`[review-result] Pipeline fix request failed, falling back to simple fixer`)
  return await spawnSimpleFixer(fixNeeded, projectName, projectPath, dashboardPath)
}

/**
 * Handle review result using simple flow (no orchestration/pipeline tracking)
 * Used for ad-hoc projects or manual reviews without full swarm orchestration
 */
async function handleSimpleReviewResult(
  body: ReviewResultRequest,
  projectName: string,
  projectPath: string,
  dashboardPath: string
) {
  if (body.status === 'approved') {
    // Check if ALL tasks in progress.md are complete before marking project done
    const { parseTaskGraph } = await import('../../../utils/orchestrator')
    const { readFile } = await import('fs/promises')
    
    try {
      const progressPath = join(projectPath, 'progress.md')
      const progressContent = await readFile(progressPath, 'utf-8')
      const graph = parseTaskGraph(progressContent)
      
      const incompleteTasks = Array.from(graph.tasks.values()).filter(t => !t.done)
      
      if (incompleteTasks.length > 0) {
        // Still have incomplete tasks - don't mark project complete
        const taskNames = incompleteTasks.map(t => t.id).join(', ')
        console.log(`[review-result] Review approved but ${incompleteTasks.length} tasks still incomplete: ${taskNames}`)
        
        await logActivity(projectPath, projectName, 'review-approved',
          `Review approved. ${incompleteTasks.length} tasks remaining: ${taskNames}`)
        
        // Trigger orchestrator to spawn workers for remaining ready tasks
        const orchResult = await triggerOrchestrator(projectPath, projectName)
        
        return {
          status: 'approved',
          message: `Review passed. ${incompleteTasks.length} tasks still incomplete: ${taskNames}`,
          incompleteTasks: incompleteTasks.map(t => t.id),
          orchestratorTriggered: orchResult.triggered,
          projectComplete: false
        }
      }
    } catch (err) {
      console.warn(`[review-result] Could not check progress.md: ${err}`)
      // Fall through to mark complete if we can't read progress
    }
    
    // All tasks done - mark project complete
    try {
      await updateProjectPhase(projectPath, projectName, 'complete', 'completed')
      await logActivity(projectPath, projectName, 'complete', 
        'Project COMPLETED - review approved, all work done!')
    } catch (err) {
      console.error('Failed to mark project complete:', err)
    }
    
    return {
      status: 'approved',
      message: 'Review passed - project marked COMPLETE',
      nextStep: 'complete',
      projectComplete: true
    }
  }
  
  // REQUEST_CHANGES means changes are needed - no auto-completion regardless of severity
  // Reviewer made a deliberate choice; respect it
  const allFindings = body.findings || []
  
  if (allFindings.length === 0) {
    // No findings but reviewer said request_changes - log and await human decision
    await logActivity(projectPath, projectName, 'review-blocked',
      'Review requested changes but no specific findings provided')
    
    return {
      status: 'needs_clarification',
      message: 'Reviewer requested changes but provided no specific findings. Awaiting clarification.',
      projectComplete: false
    }
  }
  
  // Spawn fixer for ALL findings, not just high/critical
  return await spawnSimpleFixer(allFindings, projectName, projectPath, dashboardPath)
}

/**
 * Spawn a simple fixer agent (without pipeline tracking)
 */
async function spawnSimpleFixer(
  fixNeeded: ReviewFinding[],
  projectName: string,
  projectPath: string,
  dashboardPath: string
) {
  const fixPrompt = `[SWARMOPS FIXER] Project: ${projectName}

You are a fixer agent addressing High/Critical issues found during code review.

**Project Path:** ${projectPath}
**Dashboard Path:** ${dashboardPath}

## Issues to Fix (High/Critical only)

${fixNeeded.map((f, i) => `
### Issue ${i + 1} [${f.severity.toUpperCase()}]
**File:** ${f.file}${f.line ? ` (Line ${f.line})` : ''}
**Problem:** ${f.description}
${f.fix ? `**Suggested Fix:** ${f.fix}` : ''}
`).join('\n')}

## Instructions

1. Fix EACH issue listed above
2. For each fix:
   - Open the file
   - Locate the problem (use line number if provided)
   - Apply the fix
   - Verify it doesn't break anything else
3. After ALL fixes are done, trigger re-review:

\`\`\`bash
curl -X POST http://localhost:3939/api/projects/${projectName}/fix-complete \\
  -H "Content-Type: application/json" \\
  -d '{"issuesFixed": ${fixNeeded.length}}'
\`\`\`

This will automatically spawn a reviewer to verify your fixes.`

  try {
    await wakeAgent(fixPrompt)
    
    // Log fixer spawn
    await logActivity(projectPath, projectName, 'spawn',
      `Fixer agent spawned for ${fixNeeded.length} High/Critical issues (legacy flow)`)
    
    return {
      status: 'fixing',
      message: `Spawned fixer for ${fixNeeded.length} issues`,
      fixNeeded,
      nextStep: 're-review after fixes'
    }
  } catch (err) {
    return {
      status: 'error',
      message: `Failed to spawn fixer: ${err}`,
      fixNeeded
    }
  }
}
