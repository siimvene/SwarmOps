/**
 * Work Ledger Storage (JSONL)
 * P1-07: Append-only JSONL-based storage for work items
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { StorageError, NotFoundError, generateId, timestamp } from './base';
import {
  WorkItem,
  WorkStatus,
  WorkCreateInput,
  WorkEvent,
  WorkEventInput,
  WorkQueryFilters,
  WorkListResult,
} from '../types/work';
import { getWorkStateMachine, InvalidTransitionError } from '../state/work-state';

/** Default storage directory for work ledger */
const DEFAULT_WORK_DIR = process.env.ORCHESTRATOR_DATA_DIR ? join(process.env.ORCHESTRATOR_DATA_DIR, 'work') : './data/orchestrator/work';

/**
 * JSONL record types for append-only ledger
 */
type WorkLedgerRecord = 
  | { recordType: 'create'; item: WorkItem }
  | { recordType: 'event'; workId: string; event: WorkEvent }
  | { recordType: 'status'; workId: string; status: WorkStatus; timestamp: string; error?: string }
  | { recordType: 'update'; workId: string; updates: Partial<WorkItem>; timestamp: string };

/**
 * Get the date string (YYYY-MM-DD) for a timestamp
 */
function getDateString(isoTimestamp?: string): string {
  const date = isoTimestamp ? new Date(isoTimestamp) : new Date();
  return date.toISOString().split('T')[0];
}

/**
 * Work ledger storage using JSONL files
 * Organized by daily files: YYYY-MM-DD.jsonl
 */
export class WorkStorage {
  private workDir: string;
  private cache: Map<string, WorkItem> = new Map();
  private loadedDates: Set<string> = new Set();

  constructor(workDir: string = DEFAULT_WORK_DIR) {
    this.workDir = workDir;
  }

  /**
   * Ensure the storage directory exists
   */
  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.workDir, { recursive: true });
  }

  /**
   * Get the file path for a specific date
   */
  private getFilePath(date: string): string {
    return path.join(this.workDir, `${date}.jsonl`);
  }

  /**
   * Append a record to the JSONL file for a given date
   */
  private async appendRecord(date: string, record: WorkLedgerRecord): Promise<void> {
    await this.ensureDirectory();
    const filePath = this.getFilePath(date);
    const line = JSON.stringify(record) + '\n';
    await fs.appendFile(filePath, line, 'utf-8');
  }

  /**
   * Load all records from a daily file and reconstruct work items
   */
  private async loadDate(date: string): Promise<void> {
    if (this.loadedDates.has(date)) return;

    const filePath = this.getFilePath(date);
    
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);
      
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as WorkLedgerRecord;
          this.applyRecord(record);
        } catch (parseError) {
          console.error(`Failed to parse JSONL line in ${filePath}:`, parseError);
        }
      }
      
      this.loadedDates.add(date);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist yet, that's fine
        this.loadedDates.add(date);
        return;
      }
      throw new StorageError(`Failed to load work ledger for ${date}: ${(error as Error).message}`);
    }
  }

  /**
   * Apply a ledger record to the in-memory cache
   */
  private applyRecord(record: WorkLedgerRecord): void {
    switch (record.recordType) {
      case 'create':
        this.cache.set(record.item.id, record.item);
        break;
      
      case 'event': {
        const item = this.cache.get(record.workId);
        if (item) {
          item.events.push(record.event);
          item.timestamps.updatedAt = record.event.timestamp;
        }
        break;
      }
      
      case 'status': {
        const item = this.cache.get(record.workId);
        if (item) {
          item.status = record.status;
          item.timestamps.updatedAt = record.timestamp;
          if (record.error) {
            item.error = record.error;
          }
          // Update lifecycle timestamps
          if (record.status === 'running' && !item.timestamps.startedAt) {
            item.timestamps.startedAt = record.timestamp;
          }
          if (['complete', 'failed', 'cancelled'].includes(record.status)) {
            item.timestamps.completedAt = record.timestamp;
          }
        }
        break;
      }
      
      case 'update': {
        const item = this.cache.get(record.workId);
        if (item) {
          Object.assign(item, record.updates);
          item.timestamps.updatedAt = record.timestamp;
        }
        break;
      }
    }
  }

  /**
   * Load work items for a date range
   */
  private async loadDateRange(fromDate: string, toDate: string): Promise<void> {
    const start = new Date(fromDate);
    const end = new Date(toDate);
    
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      await this.loadDate(dateStr);
    }
  }

  /**
   * List available date files in the storage directory
   */
  private async listDateFiles(): Promise<string[]> {
    try {
      await this.ensureDirectory();
      const files = await fs.readdir(this.workDir);
      return files
        .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .map(f => f.replace('.jsonl', ''))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Create a new work item
   */
  async create(input: WorkCreateInput): Promise<WorkItem> {
    const now = timestamp();
    const date = getDateString(now);

    const item: WorkItem = {
      id: generateId(),
      type: input.type,
      status: 'pending',
      roleId: input.roleId,
      sessionKey: input.sessionKey,
      parentId: input.parentId,
      childIds: [],
      title: input.title,
      description: input.description,
      input: input.input,
      iterations: 0,
      timestamps: {
        createdAt: now,
        updatedAt: now,
      },
      events: [{
        timestamp: now,
        type: 'created',
        message: `Work item created: ${input.title}`,
      }],
      tags: input.tags,
      priority: input.priority ?? 0,
    };

    // Append to ledger
    await this.appendRecord(date, { recordType: 'create', item });
    
    // Update cache
    this.cache.set(item.id, item);
    this.loadedDates.add(date);

    // If this has a parent, update the parent's childIds
    if (input.parentId) {
      const parent = await this.get(input.parentId).catch(() => null);
      if (parent) {
        parent.childIds.push(item.id);
        const parentDate = getDateString(parent.timestamps.createdAt);
        await this.appendRecord(parentDate, {
          recordType: 'update',
          workId: parent.id,
          updates: { childIds: parent.childIds },
          timestamp: now,
        });
      }
    }

    return item;
  }

  /**
   * Get a work item by ID
   */
  async get(id: string): Promise<WorkItem> {
    // First check cache
    if (this.cache.has(id)) {
      return this.cache.get(id)!;
    }

    // Load all available dates to find the item
    const dates = await this.listDateFiles();
    for (const date of dates) {
      await this.loadDate(date);
      if (this.cache.has(id)) {
        return this.cache.get(id)!;
      }
    }

    throw new NotFoundError('WorkItem', id);
  }

  /**
   * List work items with optional filters
   */
  async list(filters: WorkQueryFilters = {}): Promise<WorkListResult> {
    // Determine which dates to load
    if (filters.date) {
      await this.loadDate(filters.date);
    } else if (filters.fromDate && filters.toDate) {
      await this.loadDateRange(filters.fromDate, filters.toDate);
    } else {
      // Load all available dates
      const dates = await this.listDateFiles();
      for (const date of dates) {
        await this.loadDate(date);
      }
    }

    // Filter items
    let items = Array.from(this.cache.values());

    // Apply filters
    if (filters.date) {
      items = items.filter(item => 
        getDateString(item.timestamps.createdAt) === filters.date
      );
    }

    if (filters.fromDate) {
      items = items.filter(item => 
        getDateString(item.timestamps.createdAt) >= filters.fromDate!
      );
    }

    if (filters.toDate) {
      items = items.filter(item => 
        getDateString(item.timestamps.createdAt) <= filters.toDate!
      );
    }

    if (filters.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      items = items.filter(item => statuses.includes(item.status));
    }

    if (filters.type) {
      const types = Array.isArray(filters.type) ? filters.type : [filters.type];
      items = items.filter(item => types.includes(item.type));
    }

    if (filters.roleId) {
      items = items.filter(item => item.roleId === filters.roleId);
    }

    if (filters.parentId) {
      items = items.filter(item => item.parentId === filters.parentId);
    }

    if (filters.tag) {
      items = items.filter(item => item.tags?.includes(filters.tag!));
    }

    // Sort by creation time (newest first)
    items.sort((a, b) => 
      new Date(b.timestamps.createdAt).getTime() - new Date(a.timestamps.createdAt).getTime()
    );

    const total = items.length;

    // Apply pagination
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? 100;
    items = items.slice(offset, offset + limit);

    return {
      items,
      total,
      hasMore: offset + items.length < total,
    };
  }

  /**
   * Append an event to a work item
   */
  async appendEvent(id: string, eventInput: WorkEventInput): Promise<WorkItem> {
    const item = await this.get(id);
    const now = timestamp();
    
    const event: WorkEvent = {
      timestamp: now,
      type: eventInput.type,
      message: eventInput.message,
      data: eventInput.data,
    };

    // Append to ledger
    const date = getDateString(item.timestamps.createdAt);
    await this.appendRecord(date, { recordType: 'event', workId: id, event });

    // Update cache
    item.events.push(event);
    item.timestamps.updatedAt = now;

    return item;
  }

  /**
   * Update the status of a work item
   */
  async updateStatus(id: string, newStatus: WorkStatus, error?: string): Promise<WorkItem> {
    const item = await this.get(id);
    const stateMachine = getWorkStateMachine();
    
    // Validate transition
    stateMachine.transition(item.status, newStatus);
    
    const now = timestamp();
    const date = getDateString(item.timestamps.createdAt);

    // Append status change to ledger
    await this.appendRecord(date, {
      recordType: 'status',
      workId: id,
      status: newStatus,
      timestamp: now,
      error,
    });

    // Also append an event
    const eventMessage = error 
      ? `Status changed to ${newStatus}: ${error}`
      : `Status changed to ${newStatus}`;
    
    await this.appendRecord(date, {
      recordType: 'event',
      workId: id,
      event: {
        timestamp: now,
        type: 'status_change',
        message: eventMessage,
        data: { from: item.status, to: newStatus, error },
      },
    });

    // Update cache
    item.status = newStatus;
    item.timestamps.updatedAt = now;
    if (error) {
      item.error = error;
    }
    if (newStatus === 'running' && !item.timestamps.startedAt) {
      item.timestamps.startedAt = now;
    }
    if (['complete', 'failed', 'cancelled'].includes(newStatus)) {
      item.timestamps.completedAt = now;
    }
    item.events.push({
      timestamp: now,
      type: 'status_change',
      message: eventMessage,
      data: { from: item.status, to: newStatus, error },
    });

    return item;
  }

  /**
   * Cancel a work item
   */
  async cancel(id: string, reason?: string): Promise<WorkItem> {
    return this.updateStatus(id, 'cancelled', reason || 'Cancelled by user');
  }

  /**
   * Get child work items for a parent
   */
  async getChildren(parentId: string): Promise<WorkItem[]> {
    const result = await this.list({ parentId });
    return result.items;
  }

  /**
   * Update work item output
   */
  async setOutput(id: string, output: Record<string, unknown>): Promise<WorkItem> {
    const item = await this.get(id);
    const now = timestamp();
    const date = getDateString(item.timestamps.createdAt);

    await this.appendRecord(date, {
      recordType: 'update',
      workId: id,
      updates: { output },
      timestamp: now,
    });

    item.output = output;
    item.timestamps.updatedAt = now;

    return item;
  }

  /**
   * Increment the iteration count
   */
  async incrementIterations(id: string): Promise<WorkItem> {
    const item = await this.get(id);
    const now = timestamp();
    const date = getDateString(item.timestamps.createdAt);

    const newIterations = item.iterations + 1;
    
    await this.appendRecord(date, {
      recordType: 'update',
      workId: id,
      updates: { iterations: newIterations },
      timestamp: now,
    });

    item.iterations = newIterations;
    item.timestamps.updatedAt = now;

    return item;
  }

  /**
   * Clear the in-memory cache (force reload on next access)
   */
  invalidateCache(): void {
    this.cache.clear();
    this.loadedDates.clear();
  }

  /**
   * Get the storage directory path
   */
  getWorkDir(): string {
    return this.workDir;
  }
}

/** Singleton instance for default storage path */
let defaultStorage: WorkStorage | null = null;

/**
 * Get the default WorkStorage instance
 */
export function getWorkStorage(): WorkStorage {
  if (!defaultStorage) {
    defaultStorage = new WorkStorage();
  }
  return defaultStorage;
}

// Re-export the InvalidTransitionError for convenience
export { InvalidTransitionError };
