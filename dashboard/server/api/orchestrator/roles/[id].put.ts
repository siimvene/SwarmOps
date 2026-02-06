import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
import { invalidateRoleCache } from '../../../utils/role-loader'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { requireAuth } from '../../../utils/security'

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
  const id = getRouterParam(event, 'id')
  const body = await readBody(event)
  
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Role ID required' })
  }

  const filePath = join(DATA_DIR, 'roles.json')
  let roles: Role[] = []
  
  try {
    const data = await readFile(filePath, 'utf-8')
    roles = JSON.parse(data)
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'Role not found' })
  }

  const index = roles.findIndex(r => r.id === id)
  if (index === -1) {
    throw createError({ statusCode: 404, statusMessage: 'Role not found' })
  }

  roles[index] = {
    ...roles[index],
    ...body,
    id, // Don't allow ID change
    updatedAt: new Date().toISOString()
  }

  await writeFile(filePath, JSON.stringify(roles, null, 2))

  invalidateRoleCache()
  return roles[index]
})
