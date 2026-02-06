import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
import { invalidateRoleCache } from '../../utils/role-loader'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { requireAuth } from '../../utils/security'

const DATA_DIR = ORCHESTRATOR_DATA_DIR

interface Role {
  id: string
  name: string
  description: string
  model: string
  thinking: string
  instructions: string
  createdAt: string
  updatedAt: string
}

export default defineEventHandler(async (event) => {
  requireAuth(event)
  const body = await readBody(event)
  
  if (!body.name) {
    throw createError({ statusCode: 400, statusMessage: 'Name is required' })
  }

  const filePath = join(DATA_DIR, 'roles.json')
  let roles: Role[] = []
  
  try {
    const data = await readFile(filePath, 'utf-8')
    roles = JSON.parse(data)
  } catch {}

  const newRole: Role = {
    id: body.id || randomUUID(),
    name: body.name,
    description: body.description || '',
    model: body.model || 'anthropic/claude-sonnet-4-20250514',
    thinking: body.thinking || 'low',
    instructions: body.instructions || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }

  roles.push(newRole)
  await writeFile(filePath, JSON.stringify(roles, null, 2))

  return newRole
})
