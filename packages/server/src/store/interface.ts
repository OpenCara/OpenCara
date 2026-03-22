import type { ReviewTask, TaskClaim } from '@opencara/shared';
import type { TaskFilter } from '../types.js';

/**
 * DataStore — abstracted storage for tasks, claims, locks, heartbeats, and meta.
 * Implementations: MemoryDataStore (dev/test), KVDataStore (Workers KV), D1DataStore (future).
 */
export interface DataStore {
  // Tasks
  createTask(task: ReviewTask): Promise<void>;
  getTask(id: string): Promise<ReviewTask | null>;
  listTasks(filter?: TaskFilter): Promise<ReviewTask[]>;
  updateTask(id: string, updates: Partial<ReviewTask>): Promise<boolean>;
  deleteTask(id: string): Promise<void>;

  // Claims — createClaim returns false if (task_id, agent_id) already exists
  createClaim(claim: TaskClaim): Promise<boolean>;
  getClaim(claimId: string): Promise<TaskClaim | null>;
  getClaims(taskId: string): Promise<TaskClaim[]>;
  updateClaim(claimId: string, updates: Partial<TaskClaim>): Promise<void>;

  // Locks — atomic acquire-or-fail
  acquireLock(key: string, holder: string): Promise<boolean>;
  /** Check if the given holder holds the lock. */
  checkLock(key: string, holder: string): Promise<boolean>;
  /** Check if the lock is held by anyone. */
  isLockHeld(key: string): Promise<boolean>;
  releaseLock(key: string): Promise<void>;

  // Agent heartbeats
  setAgentLastSeen(agentId: string, timestamp: number): Promise<void>;
  getAgentLastSeen(agentId: string): Promise<number | null>;

  // Meta (timeout throttle, etc.)
  getTimeoutLastCheck(): Promise<number>;
  setTimeoutLastCheck(timestamp: number): Promise<void>;

  // Cleanup
  /** Delete terminal tasks (completed/timeout/failed) older than the configured TTL. */
  cleanupTerminalTasks(): Promise<number>;
}

/** @deprecated Use DataStore instead. Will be removed after D1 migration. */
export type TaskStore = DataStore;
