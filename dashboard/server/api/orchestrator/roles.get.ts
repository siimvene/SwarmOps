import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
import { readFile } from 'fs/promises'
import { join } from 'path'

const DATA_DIR = ORCHESTRATOR_DATA_DIR

export default defineEventHandler(async () => {
  try {
    const data = await readFile(join(DATA_DIR, 'roles.json'), 'utf-8')
    return JSON.parse(data)
  } catch (err) {
    // Return built-in defaults if file doesn't exist or is empty
    return [
      {
        id: 'architect',
        name: 'architect',
        description: 'High-level system design and planning',
        model: 'anthropic/claude-opus-4-5',
        thinking: 'high',
        instructions: 'You are a system architect. Focus on high-level design, interfaces, and overall structure.',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'builder',
        name: 'builder', 
        description: 'Implementation and coding tasks',
        model: 'anthropic/claude-sonnet-4-20250514',
        thinking: 'low',
        instructions: 'You are a builder. Focus on implementing features according to specs. Write clean, working code.',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'reviewer',
        name: 'reviewer',
        description: 'Code review and quality assessment',
        model: 'anthropic/claude-sonnet-4-20250514',
        thinking: 'medium',
        instructions: 'You are a code reviewer. Check for bugs, suggest improvements, and ensure quality standards.',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  }
})
