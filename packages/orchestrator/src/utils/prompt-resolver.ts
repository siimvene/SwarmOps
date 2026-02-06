/**
 * Prompt file resolution utility
 * Resolves role instructions from either promptFile (markdown) or inline instructions
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, isAbsolute } from 'path';
import { Role } from '../types/role';

/** Default base path for relative prompt files */
const DEFAULT_PROMPTS_BASE = process.env.ORCHESTRATOR_DATA_DIR ? join(process.env.ORCHESTRATOR_DATA_DIR, 'prompts') : './data/orchestrator/prompts';

/**
 * Resolve instructions for a role
 * If promptFile is set and exists, reads from file; otherwise uses instructions field
 */
export async function resolveInstructions(
  role: Role,
  basePath: string = DEFAULT_PROMPTS_BASE
): Promise<string> {
  // No promptFile specified - use inline instructions
  if (!role.promptFile) {
    return role.instructions;
  }

  // Resolve path (absolute or relative to base)
  const filePath = isAbsolute(role.promptFile)
    ? role.promptFile
    : resolve(basePath, role.promptFile);

  // Check if file exists
  if (!existsSync(filePath)) {
    console.warn(
      `[prompt-resolver] promptFile not found: ${filePath}, falling back to inline instructions`
    );
    return role.instructions;
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    return content.trim();
  } catch (error) {
    console.warn(
      `[prompt-resolver] Failed to read promptFile: ${filePath}`,
      error
    );
    return role.instructions;
  }
}

/**
 * Resolve instructions synchronously (for contexts where async isn't available)
 */
export function resolveInstructionsSync(
  role: Role,
  basePath: string = DEFAULT_PROMPTS_BASE
): string {
  const { readFileSync } = require('fs');

  if (!role.promptFile) {
    return role.instructions;
  }

  const filePath = isAbsolute(role.promptFile)
    ? role.promptFile
    : resolve(basePath, role.promptFile);

  if (!existsSync(filePath)) {
    console.warn(
      `[prompt-resolver] promptFile not found: ${filePath}, falling back to inline instructions`
    );
    return role.instructions;
  }

  try {
    return readFileSync(filePath, 'utf-8').trim();
  } catch (error) {
    console.warn(
      `[prompt-resolver] Failed to read promptFile: ${filePath}`,
      error
    );
    return role.instructions;
  }
}
