/**
 * Role storage layer - file-based JSON persistence
 */

import { BaseStorage, NotFoundError, ConflictError, generateId, timestamp } from './base';
import { Role, RoleCreateInput, RoleUpdateInput, DEFAULT_ROLE_VALUES, BUILTIN_ROLES } from '../types';

/** Default storage path for roles */
const DEFAULT_ROLES_PATH = process.env.ORCHESTRATOR_DATA_DIR ? join(process.env.ORCHESTRATOR_DATA_DIR, 'roles.json') : './data/orchestrator/roles.json';

/**
 * Storage class for Role entities
 */
export class RoleStorage extends BaseStorage<Role> {
  private initialized = false;

  constructor(filePath: string = DEFAULT_ROLES_PATH) {
    super(filePath);
  }

  /**
   * Initialize storage with built-in roles if empty
   */
  private async initialize(): Promise<void> {
    if (this.initialized) return;

    const data = await this.readData();
    
    // Add built-in roles if they don't exist
    let modified = false;
    for (const builtinRole of BUILTIN_ROLES) {
      const exists = data.some(r => r.name === builtinRole.name && r.builtin);
      if (!exists) {
        const now = timestamp();
        data.push({
          ...builtinRole,
          id: generateId(),
          createdAt: now,
          updatedAt: now,
        });
        modified = true;
      }
    }

    if (modified) {
      await this.writeData(data);
    }

    this.initialized = true;
  }

  /**
   * List all roles
   */
  async list(): Promise<Role[]> {
    await this.initialize();
    return this.readData();
  }

  /**
   * Get a role by ID
   */
  async get(id: string): Promise<Role> {
    await this.initialize();
    const data = await this.readData();
    const role = data.find(r => r.id === id);
    
    if (!role) {
      throw new NotFoundError('Role', id);
    }
    
    return role;
  }

  /**
   * Get a role by name
   */
  async getByName(name: string): Promise<Role | null> {
    await this.initialize();
    const data = await this.readData();
    return data.find(r => r.name.toLowerCase() === name.toLowerCase()) || null;
  }

  /**
   * Create a new role
   */
  async create(input: RoleCreateInput): Promise<Role> {
    await this.initialize();
    const data = await this.readData();

    // Check for duplicate name
    const existing = data.find(r => r.name.toLowerCase() === input.name.toLowerCase());
    if (existing) {
      throw new ConflictError(`Role with name "${input.name}" already exists`);
    }

    const now = timestamp();
    const role: Role = {
      id: generateId(),
      name: input.name,
      description: input.description ?? DEFAULT_ROLE_VALUES.description,
      model: input.model ?? DEFAULT_ROLE_VALUES.model,
      thinking: input.thinking ?? DEFAULT_ROLE_VALUES.thinking,
      instructions: input.instructions ?? DEFAULT_ROLE_VALUES.instructions,
      promptFile: input.promptFile,
      createdAt: now,
      updatedAt: now,
    };

    data.push(role);
    await this.writeData(data);

    return role;
  }

  /**
   * Update an existing role
   */
  async update(id: string, input: RoleUpdateInput): Promise<Role> {
    await this.initialize();
    const data = await this.readData();
    const index = data.findIndex(r => r.id === id);

    if (index === -1) {
      throw new NotFoundError('Role', id);
    }

    const existing = data[index];

    // Prevent modifying built-in role names
    if (existing.builtin && input.name && input.name !== existing.name) {
      throw new ConflictError('Cannot rename built-in roles');
    }

    // Check for duplicate name if changing name
    if (input.name && input.name.toLowerCase() !== existing.name.toLowerCase()) {
      const duplicate = data.find(r => r.name.toLowerCase() === input.name!.toLowerCase());
      if (duplicate) {
        throw new ConflictError(`Role with name "${input.name}" already exists`);
      }
    }

    const updated: Role = {
      ...existing,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.model !== undefined && { model: input.model }),
      ...(input.thinking !== undefined && { thinking: input.thinking }),
      ...(input.instructions !== undefined && { instructions: input.instructions }),
      ...(input.promptFile !== undefined && { promptFile: input.promptFile }),
      updatedAt: timestamp(),
    };

    data[index] = updated;
    await this.writeData(data);

    return updated;
  }

  /**
   * Delete a role by ID
   */
  async delete(id: string): Promise<void> {
    await this.initialize();
    const data = await this.readData();
    const index = data.findIndex(r => r.id === id);

    if (index === -1) {
      throw new NotFoundError('Role', id);
    }

    const role = data[index];
    if (role.builtin) {
      throw new ConflictError('Cannot delete built-in roles');
    }

    data.splice(index, 1);
    await this.writeData(data);
  }

  /**
   * Check if a role name is available
   */
  async isNameAvailable(name: string, excludeId?: string): Promise<boolean> {
    await this.initialize();
    const data = await this.readData();
    return !data.some(r => 
      r.name.toLowerCase() === name.toLowerCase() && 
      r.id !== excludeId
    );
  }
}

/** Singleton instance for default storage path */
let defaultStorage: RoleStorage | null = null;

/**
 * Get the default RoleStorage instance
 */
export function getRoleStorage(): RoleStorage {
  if (!defaultStorage) {
    defaultStorage = new RoleStorage();
  }
  return defaultStorage;
}
