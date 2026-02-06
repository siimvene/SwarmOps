/**
 * Session Storage & Lifecycle Management
 * P1-11: File-based storage for tracked sessions with lifecycle methods
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { StorageError, NotFoundError, generateId, timestamp } from './base';
import {
  TrackedSession,
  SessionStatus,
  SessionSpawnInput,
  SessionListFilters,
  SessionListResult,
  SessionUpdateInput,
  SessionTokenUsage,
  DEFAULT_TOKEN_USAGE,
  ACTIVE_SESSION_STATUSES,
} from '../types/session';

/** Default storage path for active sessions */
const DEFAULT_SESSIONS_PATH = process.env.ORCHESTRATOR_DATA_DIR ? join(process.env.ORCHESTRATOR_DATA_DIR, 'sessions/active.json') : './data/orchestrator/sessions/active.json';

/**
 * Session storage with file-based persistence and concurrent update safety
 */
export class SessionStorage {
  private filePath: string;
  private cache: Map<string, TrackedSession> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string = DEFAULT_SESSIONS_PATH) {
    this.filePath = filePath;
  }

  /**
   * Ensure the storage directory exists
   */
  private async ensureDirectory(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
  }

  /**
   * Read sessions from storage
   */
  private async readSessions(): Promise<Map<string, TrackedSession>> {
    if (this.cache !== null) {
      return this.cache;
    }

    try {
      await this.ensureDirectory();
      const content = await fs.readFile(this.filePath, 'utf-8');
      const sessions = JSON.parse(content) as TrackedSession[];
      this.cache = new Map(sessions.map(s => [s.sessionKey, s]));
      return this.cache;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = new Map();
        return this.cache;
      }
      throw new StorageError(`Failed to read sessions: ${(error as Error).message}`);
    }
  }

  /**
   * Write sessions to storage with atomic write and queuing for concurrent safety
   */
  private async writeSessions(sessions: Map<string, TrackedSession>): Promise<void> {
    // Queue writes to prevent concurrent file access issues
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await this.ensureDirectory();
        const tempPath = `${this.filePath}.tmp`;
        const data = Array.from(sessions.values());
        const content = JSON.stringify(data, null, 2);

        // Atomic write: write to temp, then rename
        await fs.writeFile(tempPath, content, 'utf-8');
        await fs.rename(tempPath, this.filePath);

        this.cache = sessions;
      } catch (error: unknown) {
        throw new StorageError(`Failed to write sessions: ${(error as Error).message}`);
      }
    });

    await this.writeQueue;
  }

  /**
   * Track a new session
   */
  async track(input: SessionSpawnInput, sessionKey?: string): Promise<TrackedSession> {
    const sessions = await this.readSessions();
    const now = timestamp();

    // Generate session key if not provided
    const sessionId = generateId();
    const key = sessionKey || `agent:main:subagent:${sessionId}`;

    // Check for duplicate
    if (sessions.has(key)) {
      throw new StorageError(`Session already tracked: ${key}`);
    }

    const session: TrackedSession = {
      sessionKey: key,
      sessionId,
      workItemId: input.workItemId,
      roleId: input.roleId,
      status: 'starting',
      label: input.label,
      spawnedAt: now,
      lastActivityAt: now,
      tokenUsage: { ...DEFAULT_TOKEN_USAGE },
      task: input.task,
    };

    sessions.set(key, session);
    await this.writeSessions(sessions);

    return session;
  }

  /**
   * Get a session by key
   */
  async get(sessionKey: string): Promise<TrackedSession> {
    const sessions = await this.readSessions();
    const session = sessions.get(sessionKey);

    if (!session) {
      throw new NotFoundError('Session', sessionKey);
    }

    return session;
  }

  /**
   * List sessions with optional filters
   */
  async list(filters: SessionListFilters = {}): Promise<SessionListResult> {
    const sessions = await this.readSessions();
    let items = Array.from(sessions.values());

    // Apply filters
    if (filters.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      items = items.filter(s => statuses.includes(s.status));
    }

    if (filters.roleId) {
      items = items.filter(s => s.roleId === filters.roleId);
    }

    if (filters.workItemId) {
      items = items.filter(s => s.workItemId === filters.workItemId);
    }

    if (filters.labelContains) {
      const searchLower = filters.labelContains.toLowerCase();
      items = items.filter(s => s.label.toLowerCase().includes(searchLower));
    }

    if (filters.activeSince) {
      items = items.filter(s => s.lastActivityAt >= filters.activeSince!);
    }

    // Sort by spawn time (newest first)
    items.sort((a, b) => 
      new Date(b.spawnedAt).getTime() - new Date(a.spawnedAt).getTime()
    );

    const total = items.length;

    // Apply pagination
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? 100;
    items = items.slice(offset, offset + limit);

    return {
      sessions: items,
      total,
      hasMore: offset + items.length < total,
    };
  }

  /**
   * Update a session
   */
  async update(sessionKey: string, updates: SessionUpdateInput): Promise<TrackedSession> {
    const sessions = await this.readSessions();
    const session = sessions.get(sessionKey);

    if (!session) {
      throw new NotFoundError('Session', sessionKey);
    }

    // Apply updates
    if (updates.status !== undefined) {
      session.status = updates.status;
    }

    if (updates.lastActivityAt !== undefined) {
      session.lastActivityAt = updates.lastActivityAt;
    } else {
      // Auto-update lastActivityAt on any modification
      session.lastActivityAt = timestamp();
    }

    if (updates.tokenUsage) {
      session.tokenUsage = {
        input: updates.tokenUsage.input ?? session.tokenUsage.input,
        output: updates.tokenUsage.output ?? session.tokenUsage.output,
        thinking: updates.tokenUsage.thinking ?? session.tokenUsage.thinking,
      };
    }

    if (updates.error !== undefined) {
      session.error = updates.error;
    }

    if (updates.exitCode !== undefined) {
      session.exitCode = updates.exitCode;
    }

    sessions.set(sessionKey, session);
    await this.writeSessions(sessions);

    return session;
  }

  /**
   * Remove a session from tracking
   */
  async remove(sessionKey: string): Promise<void> {
    const sessions = await this.readSessions();

    if (!sessions.has(sessionKey)) {
      throw new NotFoundError('Session', sessionKey);
    }

    sessions.delete(sessionKey);
    await this.writeSessions(sessions);
  }

  // ============================================
  // Lifecycle convenience methods
  // ============================================

  /**
   * Mark a session as active
   */
  async markActive(sessionKey: string): Promise<TrackedSession> {
    return this.update(sessionKey, { status: 'active' });
  }

  /**
   * Mark a session as idle
   */
  async markIdle(sessionKey: string): Promise<TrackedSession> {
    return this.update(sessionKey, { status: 'idle' });
  }

  /**
   * Mark a session as stopping
   */
  async markStopping(sessionKey: string): Promise<TrackedSession> {
    return this.update(sessionKey, { status: 'stopping' });
  }

  /**
   * Mark a session as stopped
   */
  async markStopped(sessionKey: string, exitCode?: number, error?: string): Promise<TrackedSession> {
    return this.update(sessionKey, { 
      status: 'stopped',
      exitCode,
      error,
    });
  }

  /**
   * Update token usage for a session
   */
  async addTokenUsage(sessionKey: string, usage: Partial<SessionTokenUsage>): Promise<TrackedSession> {
    const session = await this.get(sessionKey);
    
    return this.update(sessionKey, {
      tokenUsage: {
        input: session.tokenUsage.input + (usage.input ?? 0),
        output: session.tokenUsage.output + (usage.output ?? 0),
        thinking: session.tokenUsage.thinking + (usage.thinking ?? 0),
      },
    });
  }

  // ============================================
  // Cleanup methods
  // ============================================

  /**
   * Remove stale sessions that haven't been active for maxAgeMs
   */
  async pruneStale(maxAgeMs: number): Promise<number> {
    const sessions = await this.readSessions();
    const now = Date.now();
    const staleKeys: string[] = [];

    for (const [key, session] of sessions) {
      const lastActivity = new Date(session.lastActivityAt).getTime();
      const age = now - lastActivity;

      // Only prune stopped sessions or sessions that are stale
      if (session.status === 'stopped' || age > maxAgeMs) {
        staleKeys.push(key);
      }
    }

    if (staleKeys.length > 0) {
      for (const key of staleKeys) {
        sessions.delete(key);
      }
      await this.writeSessions(sessions);
    }

    return staleKeys.length;
  }

  /**
   * Remove all stopped sessions
   */
  async pruneStopped(): Promise<number> {
    const sessions = await this.readSessions();
    const stoppedKeys: string[] = [];

    for (const [key, session] of sessions) {
      if (session.status === 'stopped') {
        stoppedKeys.push(key);
      }
    }

    if (stoppedKeys.length > 0) {
      for (const key of stoppedKeys) {
        sessions.delete(key);
      }
      await this.writeSessions(sessions);
    }

    return stoppedKeys.length;
  }

  /**
   * Get all active (non-stopped) sessions
   */
  async getActiveSessions(): Promise<TrackedSession[]> {
    const result = await this.list({ status: ACTIVE_SESSION_STATUSES });
    return result.sessions;
  }

  /**
   * Check if a session exists and is active
   */
  async isActive(sessionKey: string): Promise<boolean> {
    try {
      const session = await this.get(sessionKey);
      return ACTIVE_SESSION_STATUSES.includes(session.status);
    } catch {
      return false;
    }
  }

  /**
   * Invalidate the cache (force re-read on next access)
   */
  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * Get the storage file path
   */
  getFilePath(): string {
    return this.filePath;
  }
}

/** Singleton instance */
let defaultStorage: SessionStorage | null = null;

/**
 * Get the default SessionStorage instance
 */
export function getSessionStorage(): SessionStorage {
  if (!defaultStorage) {
    defaultStorage = new SessionStorage();
  }
  return defaultStorage;
}
