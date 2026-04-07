/**
 * MockAgent — simulates a CLI agent's HTTP interactions with the server.
 *
 * Wraps Hono's app.request() calls into agent-like methods:
 * poll, claim, submitResult, reject, reportError, pollAndClaim.
 */
import type { Hono } from 'hono';
import type {
  PollResponse,
  PollTask,
  ClaimResponse,
  TaskRole,
  ReviewVerdict,
  ErrorResponse,
} from '@opencara/shared';
import type { Env, AppVariables } from '../../types.js';
import { OAUTH_HEADERS } from '../test-oauth-helper.js';

type HonoApp = Hono<{ Bindings: Env; Variables: AppVariables }>;

/** Extended claim result: either a successful ClaimResponse or a structured error. */
export type ClaimResult =
  | (ClaimResponse & { _status: 200 })
  | { claimed: false; error: ErrorResponse['error']; _status: number };

export class MockAgent {
  constructor(
    public readonly agentId: string,
    private app: HonoApp,
    private env: Env,
  ) {}

  private request(method: string, path: string, body?: unknown) {
    return this.app.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
        body: body ? JSON.stringify(body) : undefined,
      },
      this.env,
    );
  }

  /** Poll for available tasks. */
  async poll(opts?: { reviewOnly?: boolean }): Promise<PollTask[]> {
    const res = await this.request('POST', '/api/tasks/poll', {
      agent_id: this.agentId,
      review_only: opts?.reviewOnly,
    });
    const body = (await res.json()) as PollResponse;
    return body.tasks;
  }

  /** Claim a task with a specific role. Returns success or structured error. */
  async claim(
    taskId: string,
    role: TaskRole,
    opts?: { model?: string; tool?: string },
  ): Promise<ClaimResult> {
    const res = await this.request('POST', `/api/tasks/${taskId}/claim`, {
      agent_id: this.agentId,
      role,
      model: opts?.model,
      tool: opts?.tool,
    });
    const body = (await res.json()) as ClaimResponse | ErrorResponse;
    if (res.status === 200) {
      return { ...(body as ClaimResponse), _status: 200 };
    }
    const err = body as ErrorResponse;
    return { claimed: false, error: err.error, _status: res.status };
  }

  /** Submit a review result. Returns status and parsed body. */
  async submitResult(
    taskId: string,
    type: TaskRole,
    reviewText: string,
    verdict?: ReviewVerdict,
    tokensUsed?: number,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.request('POST', `/api/tasks/${taskId}/result`, {
      agent_id: this.agentId,
      type,
      review_text: reviewText,
      verdict,
      tokens_used: tokensUsed,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  /** Reject a claimed task. */
  async reject(taskId: string, reason: string): Promise<{ status: number }> {
    const res = await this.request('POST', `/api/tasks/${taskId}/reject`, {
      agent_id: this.agentId,
      reason,
    });
    return { status: res.status };
  }

  /** Report an error on a claimed task. */
  async reportError(taskId: string, error: string): Promise<{ status: number }> {
    const res = await this.request('POST', `/api/tasks/${taskId}/error`, {
      agent_id: this.agentId,
      error,
    });
    return { status: res.status };
  }

  /**
   * Convenience: poll and claim the first available task.
   * Returns null if no tasks are available.
   */
  async pollAndClaim(
    role?: TaskRole,
  ): Promise<{ taskId: string; claimResponse: ClaimResult } | null> {
    const tasks = await this.poll(role === 'review' ? { reviewOnly: true } : undefined);
    if (tasks.length === 0) return null;

    const task = tasks[0];
    const taskRole = role ?? (task.role as TaskRole);
    const claimResponse = await this.claim(task.task_id, taskRole);
    return { taskId: task.task_id, claimResponse };
  }

  /** Inject a PR event via test routes (bypasses webhook signature). */
  async injectPR(opts?: {
    owner?: string;
    repo?: string;
    prNumber?: number;
    reviewCount?: number;
    timeout?: string;
  }): Promise<{ created: boolean; taskId?: string; groupId?: string }> {
    const config =
      opts?.reviewCount || opts?.timeout
        ? {
            agentCount: opts.reviewCount ?? 1,
            preferredModels: [] as string[],
            preferredTools: [] as string[],
            ...(opts.timeout ? { timeout: opts.timeout } : {}),
          }
        : undefined;

    const res = await this.request('POST', '/test/events/pr', {
      owner: opts?.owner ?? 'test-org',
      repo: opts?.repo ?? 'test-repo',
      pr_number: opts?.prNumber ?? 1,
      config,
    });
    const body = (await res.json()) as { created: boolean; task_id?: string; group_id?: string };
    return { created: body.created, taskId: body.task_id, groupId: body.group_id };
  }

  /** Inject an issue event via test routes (bypasses webhook signature). */
  async injectIssue(opts?: {
    owner?: string;
    repo?: string;
    issueNumber?: number;
    reviewCount?: number;
    timeout?: string;
  }): Promise<{ created: boolean; taskId?: string; groupId?: string }> {
    const config = {
      agentCount: opts?.reviewCount ?? 1,
      preferredModels: [] as string[],
      preferredTools: [] as string[],
      ...(opts?.timeout ? { timeout: opts.timeout } : {}),
    };

    const res = await this.request('POST', '/test/events/issue', {
      owner: opts?.owner ?? 'test-org',
      repo: opts?.repo ?? 'test-repo',
      issue_number: opts?.issueNumber ?? 1,
      config,
    });
    const body = (await res.json()) as { created: boolean; task_id?: string; group_id?: string };
    return { created: body.created, taskId: body.task_id, groupId: body.group_id };
  }
}
