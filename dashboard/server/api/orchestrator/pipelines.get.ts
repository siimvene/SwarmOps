import { ORCHESTRATOR_DATA_DIR } from '~/server/utils/paths'
import { readFile } from 'fs/promises'
import { join } from 'path'

const DATA_DIR = ORCHESTRATOR_DATA_DIR

export default defineEventHandler(async () => {
  try {
    const data = await readFile(join(DATA_DIR, 'pipelines.json'), 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
})
