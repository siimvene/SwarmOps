import { ORCHESTRATOR_DATA_DIR, PROMPTS_DIR } from '~/server/utils/paths'
/**
 * RoleLoader - Dynamic role configuration lookup
 * 
 * Reads role definitions from roles.json and provides them to the pipeline.
 * Caches with short TTL so edits from the Roles page take effect quickly.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'

const ROLES_FILE = join(ORCHESTRATOR_DATA_DIR, 'roles.json')
const CACHE_TTL_MS = 30_000 // 30 seconds

export interface RoleConfig {
  id: string
  name: string
  model?: string
  thinking?: string
  instructions?: string
  promptFile?: string
  description?: string
}

// Default fallback configs when role not found
const FALLBACK_ROLES: Record<string, Partial<RoleConfig>> = {
  builder: {
    model: 'anthropic/claude-sonnet-4-20250514',
    thinking: 'low',
    instructions: 'You are a builder. Focus on implementing features according to specs. Write clean, working code.',
  },
  reviewer: {
    model: 'anthropic/claude-sonnet-4-20250514',
    thinking: 'medium',
    instructions: 'You are a code reviewer. Check for bugs, suggest improvements, and ensure quality standards.',
  },
  architect: {
    model: 'anthropic/claude-opus-4-5',
    thinking: 'high',
    instructions: 'You are a system architect. Focus on high-level design, interfaces, and overall structure.',
  },
  'task-decomposer': {
    model: 'anthropic/claude-opus-4-5',
    thinking: 'medium',
    instructions: 'You are a task decomposition specialist. Break down requirements into atomic, parallelizable work units.',
  },
  'security-reviewer': {
    model: 'anthropic/claude-opus-4-5',
    thinking: 'high',
    instructions: 'You are a security reviewer. Focus on finding vulnerabilities, injection risks, auth bypasses, and data leaks.',
  },
  designer: {
    model: 'anthropic/claude-sonnet-4-20250514',
    thinking: 'medium',
    instructions: 'You are a UI/UX design reviewer. Check for accessibility, consistency, and user experience issues.',
  },
}

let cachedRoles: RoleConfig[] | null = null
let cacheTimestamp = 0

async function loadRoles(): Promise<RoleConfig[]> {
  const now = Date.now()
  if (cachedRoles && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedRoles
  }

  try {
    const data = await readFile(ROLES_FILE, 'utf-8')
    cachedRoles = JSON.parse(data)
    cacheTimestamp = now
    return cachedRoles!
  } catch {
    console.warn('[role-loader] Could not read roles.json, using fallbacks')
    return []
  }
}

/**
 * Get configuration for a specific role.
 * Falls back to hardcoded defaults if role not found in roles.json.
 */
export async function getRoleConfig(roleId: string): Promise<RoleConfig> {
  const roles = await loadRoles()
  const found = roles.find(r => r.id === roleId || r.name === roleId)

  if (found) {
    // If role has a promptFile, try to read it for instructions
    if (found.promptFile) {
      try {
        const promptPath = found.promptFile.startsWith('/')
          ? found.promptFile
          : join(PROMPTS_DIR, found.promptFile)
        const promptContent = await readFile(promptPath, 'utf-8')
        return { ...found, instructions: promptContent }
      } catch {
        // promptFile not found, use inline instructions
      }
    }
    return found
  }

  // Fallback
  const fallback = FALLBACK_ROLES[roleId]
  if (fallback) {
    return { id: roleId, name: roleId, ...fallback }
  }

  // Ultimate fallback - builder defaults
  console.warn(`[role-loader] Role '${roleId}' not found, using builder defaults`)
  return {
    id: roleId,
    name: roleId,
    model: 'anthropic/claude-sonnet-4-20250514',
    thinking: 'low',
    instructions: `You are a ${roleId} agent. Complete your assigned task.`,
  }
}

/**
 * Invalidate the role cache (e.g., after role update via API)
 */
export function invalidateRoleCache(): void {
  cachedRoles = null
  cacheTimestamp = 0
}
