import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
/**
 * ConflictResolverStore - Track active AI conflict resolver sessions
 * 
 * When a conflict resolver is spawned, we store its context here so that
 * when it completes (via worker-complete webhook), we know which phase
 * to resume and what branches remain to merge.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'

const DATA_DIR = ORCHESTRATOR_DATA_DIR
const RESOLVERS_DIR = join(DATA_DIR, 'conflict-resolvers')

export interface ConflictResolverContext {
  sessionKey: string
  runId: string
  phaseNumber: number
  phaseBranch: string
  sourceBranch: string        // The branch that caused the conflict
  conflictFiles: string[]
  remainingBranches: string[] // Branches still to merge after this one
  repoDir: string
  createdAt: string
  status: 'active' | 'completed' | 'failed'
  completedAt?: string
  error?: string
}

// In-memory store for active resolvers
const activeResolvers = new Map<string, ConflictResolverContext>()

// Index by runId for quick lookup
const resolversByRun = new Map<string, Set<string>>()

/**
 * Register a new conflict resolver session
 */
export async function registerConflictResolver(ctx: {
  sessionKey: string
  runId: string
  phaseNumber: number
  phaseBranch: string
  sourceBranch: string
  conflictFiles: string[]
  remainingBranches: string[]
  repoDir: string
}): Promise<ConflictResolverContext> {
  const resolver: ConflictResolverContext = {
    ...ctx,
    createdAt: new Date().toISOString(),
    status: 'active',
  }

  activeResolvers.set(ctx.sessionKey, resolver)

  // Index by runId
  if (!resolversByRun.has(ctx.runId)) {
    resolversByRun.set(ctx.runId, new Set())
  }
  resolversByRun.get(ctx.runId)!.add(ctx.sessionKey)

  await saveResolver(resolver)
  
  console.log(`[conflict-resolver-store] Registered resolver ${ctx.sessionKey} for run ${ctx.runId} phase ${ctx.phaseNumber}`)
  console.log(`[conflict-resolver-store] Source branch: ${ctx.sourceBranch}, ${ctx.remainingBranches.length} branches remaining`)
  
  return resolver
}

/**
 * Get conflict resolver context by session key
 */
export async function getResolverBySession(sessionKey: string): Promise<ConflictResolverContext | null> {
  let resolver = activeResolvers.get(sessionKey)
  if (resolver) return resolver

  // Try loading from disk
  resolver = await loadResolver(sessionKey)
  if (resolver) {
    activeResolvers.set(sessionKey, resolver)
  }
  return resolver
}

/**
 * Get conflict resolver by runId (for stepOrder=-1 lookups)
 * Returns the most recent active resolver for the run
 */
export async function getResolverByRun(runId: string): Promise<ConflictResolverContext | null> {
  // Check in-memory first
  const sessionKeys = resolversByRun.get(runId)
  if (sessionKeys) {
    for (const key of sessionKeys) {
      const resolver = activeResolvers.get(key)
      if (resolver && resolver.status === 'active') {
        return resolver
      }
    }
  }

  // Load all resolvers for this run from disk
  const resolvers = await loadResolversForRun(runId)
  const active = resolvers.find(r => r.status === 'active')
  
  if (active) {
    activeResolvers.set(active.sessionKey, active)
    return active
  }

  return null
}

/**
 * Mark a resolver as completed
 */
export async function completeResolver(sessionKey: string, output?: string): Promise<ConflictResolverContext | null> {
  let resolver = await getResolverBySession(sessionKey)
  if (!resolver) return null

  resolver.status = 'completed'
  resolver.completedAt = new Date().toISOString()
  
  await saveResolver(resolver)
  
  console.log(`[conflict-resolver-store] Resolver ${sessionKey} completed`)
  
  return resolver
}

/**
 * Mark a resolver as failed
 */
export async function failResolver(sessionKey: string, error: string): Promise<ConflictResolverContext | null> {
  let resolver = await getResolverBySession(sessionKey)
  if (!resolver) return null

  resolver.status = 'failed'
  resolver.completedAt = new Date().toISOString()
  resolver.error = error
  
  await saveResolver(resolver)
  
  console.log(`[conflict-resolver-store] Resolver ${sessionKey} failed: ${error}`)
  
  return resolver
}

/**
 * List all resolvers for a run
 */
export async function listResolversForRun(runId: string): Promise<ConflictResolverContext[]> {
  const resolvers: ConflictResolverContext[] = []
  
  // Get from memory
  const sessionKeys = resolversByRun.get(runId)
  if (sessionKeys) {
    for (const key of sessionKeys) {
      const resolver = activeResolvers.get(key)
      if (resolver) resolvers.push(resolver)
    }
  }

  // Load from disk
  const diskResolvers = await loadResolversForRun(runId)
  for (const resolver of diskResolvers) {
    if (!resolvers.find(r => r.sessionKey === resolver.sessionKey)) {
      resolvers.push(resolver)
    }
  }

  return resolvers.sort((a, b) => 
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )
}

/**
 * Remove a resolver from tracking (cleanup)
 */
export async function removeResolver(sessionKey: string): Promise<void> {
  const resolver = activeResolvers.get(sessionKey)
  if (resolver) {
    activeResolvers.delete(sessionKey)
    const runKeys = resolversByRun.get(resolver.runId)
    if (runKeys) {
      runKeys.delete(sessionKey)
    }
  }
}

// Persistence helpers

async function saveResolver(resolver: ConflictResolverContext): Promise<void> {
  try {
    await mkdir(RESOLVERS_DIR, { recursive: true })
    const filename = `${resolver.runId}-${resolver.sessionKey.slice(-8)}.json`
    await writeFile(
      join(RESOLVERS_DIR, filename),
      JSON.stringify(resolver, null, 2)
    )
  } catch (err) {
    console.error('[conflict-resolver-store] Failed to save:', err)
  }
}

async function loadResolver(sessionKey: string): Promise<ConflictResolverContext | null> {
  try {
    const { readdir } = await import('fs/promises')
    const files = await readdir(RESOLVERS_DIR)
    
    for (const file of files) {
      if (file.endsWith(`-${sessionKey.slice(-8)}.json`)) {
        const data = await readFile(join(RESOLVERS_DIR, file), 'utf-8')
        return JSON.parse(data)
      }
    }
  } catch {
    // Directory may not exist
  }
  return null
}

async function loadResolversForRun(runId: string): Promise<ConflictResolverContext[]> {
  const resolvers: ConflictResolverContext[] = []
  try {
    const { readdir } = await import('fs/promises')
    const files = await readdir(RESOLVERS_DIR)
    
    for (const file of files) {
      if (file.startsWith(`${runId}-`) && file.endsWith('.json')) {
        const data = await readFile(join(RESOLVERS_DIR, file), 'utf-8')
        resolvers.push(JSON.parse(data))
      }
    }
  } catch {
    // Directory may not exist
  }
  return resolvers
}
