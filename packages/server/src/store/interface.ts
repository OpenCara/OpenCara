import type { ReviewTask, TaskClaim } from '@opencara/shared';
import type { TaskFilter } from '../types.js';

/**
 * TaskStore — abstracted storage for tasks, claims, and agent heartbeats.
 * Implementations: MemoryTaskStore (dev/test), KVTaskStore (Workers KV).
 */
export interface TaskStore {
  // Tasks
  createTask(task: ReviewTask): Promise<void>;
  getTask(id: string): Promise<ReviewTask | null>;
  listTasks(filter?: TaskFilter): Promise<ReviewTask[]>;
  updateTask(id: string, updates: Partial<ReviewTask>): Promise<boolean>;
  deleteTask(id: string): Promise<void>;

  // Claims
  createClaim(claim: TaskClaim): Promise<void>;
  getClaim(claimId: string): Promise<TaskClaim | null>;
  getClaims(taskId: string): Promise<TaskClaim[]>;
  updateClaim(claimId: string, updates: Partial<TaskClaim>): Promise<void>;

  // Agent last-seen (updated on each poll)
  setAgentLastSeen(agentId: string, timestamp: number): Promise<void>;
  getAgentLastSeen(agentId: string): Promise<number | null>;

  // Summary lock (prevents duplicate summary claims under KV eventual consistency)

  /** Acquire exclusive summary lock. Idempotent: returns true if same agent already holds it. */
  acquireSummaryLock(taskId: string, agentId: string): Promise<boolean>;
  /** Check if the given agent holds the summary lock. */
  checkSummaryLock(taskId: string, agentId: string): Promise<boolean>;
  /** Release the summary lock, allowing a new agent to claim the summary role. */
  releaseSummaryLock(taskId: string): Promise<void>;

  // Timeout check throttle (persisted across isolate recycles)
  getTimeoutLastCheck(): Promise<number>;
  setTimeoutLastCheck(timestamp: number): Promise<void>;

  // Cleanup
  /** Delete terminal tasks (completed/timeout/failed) older than the configured TTL. */
  cleanupTerminalTasks(): Promise<number>;
}
