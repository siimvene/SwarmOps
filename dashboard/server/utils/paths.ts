import { join } from 'path'

// Centralized path configuration
// All paths can be overridden via environment variables

export const ORCHESTRATOR_DATA_DIR = process.env.ORCHESTRATOR_DATA_DIR || join(process.cwd(), 'data', 'orchestrator')
export const PROJECTS_DIR = process.env.PROJECTS_DIR || join(process.cwd(), 'projects')
export const DASHBOARD_PATH = process.env.DASHBOARD_PATH || process.cwd()

// Derived paths
export const ROLES_FILE = join(ORCHESTRATOR_DATA_DIR, 'roles.json')
export const PIPELINES_FILE = join(ORCHESTRATOR_DATA_DIR, 'pipelines.json')
export const WORK_QUEUE_FILE = join(ORCHESTRATOR_DATA_DIR, 'work-queue.json')
export const TASK_REGISTRY_FILE = join(ORCHESTRATOR_DATA_DIR, 'task-registry.json')
export const RETRY_STATE_FILE = join(ORCHESTRATOR_DATA_DIR, 'retry-state.json')
export const ESCALATIONS_FILE = join(ORCHESTRATOR_DATA_DIR, 'escalations.json')
export const PROMPTS_DIR = join(ORCHESTRATOR_DATA_DIR, 'prompts')
export const SKILLS_DIR = join(ORCHESTRATOR_DATA_DIR, 'skills')
export const PROJECT_RUNS_DIR = join(ORCHESTRATOR_DATA_DIR, 'project-runs')
