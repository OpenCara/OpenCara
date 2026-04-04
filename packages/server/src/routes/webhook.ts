import { Hono } from 'hono';
import type {
  ReviewConfig,
  OpenCaraConfig,
  FeatureConfig,
  Feature,
  TaskRole,
  ReviewTask,
} from '@opencara/shared';
import {
  DEFAULT_REVIEW_CONFIG,
  isEventTriggerEnabled,
  isCommentTriggerEnabled,
  isLabelTriggerEnabled,
  isStatusTriggerEnabled,
} from '@opencara/shared';
import type { Env, AppVariables } from '../types.js';
import type { DataStore } from '../store/interface.js';
import type { GitHubService } from '../github/service.js';
import type { Logger } from '../logger.js';
import { shouldSkipReview, parseTimeoutMs } from '../eligibility.js';
import { rateLimitByIP } from '../middleware/rate-limit.js';
import { apiError } from '../errors.js';
import { moveToRecentlyClosed, ageOutToArchived, updateOpenEntry } from '../dedup-index.js';

/** Trusted for review triggers — includes CONTRIBUTOR. */
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR']);

/** Maintainers only — no CONTRIBUTOR. Used for implement/fix permission checks. */
const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Maximum allowed length for config.prompt (10,000 characters). */
export const MAX_PROMPT_LENGTH = 10_000;

/** Maximum allowed length for pr_review_comments (64 KB). */
export const MAX_REVIEW_COMMENTS_LENGTH = 65_536;

interface PullRequestPayload {
  action: string;
  installation?: { id: number };
  repository: {
    owner: { login: string };
    name: string;
    default_branch?: string;
    private?: boolean;
  };
  pull_request: {
    number: number;
    title: string;
    html_url: string;
    diff_url: string;
    base: { ref: string };
    head: { ref: string };
    draft?: boolean;
    labels?: Array<{ name: string }>;
    additions?: number;
    deletions?: number;
  };
  changes?: {
    title?: { from: string };
  };
  label?: { name: string };
}

interface IssueCommentPayload {
  action: string;
  installation?: { id: number };
  repository: {
    owner: { login: string };
    name: string;
    default_branch?: string;
    private?: boolean;
  };
  issue: {
    number: number;
    pull_request?: { url: string };
  };
  comment: {
    body: string;
    user: { login: string };
    author_association: string;
  };
}

interface IssuePayload {
  action: string;
  installation?: { id: number };
  repository: {
    owner: { login: string };
    name: string;
    default_branch?: string;
    private?: boolean;
  };
  issue: {
    number: number;
    html_url: string;
    title: string;
    body: string | null;
    user: { login: string };
    pull_request?: { url: string };
    labels?: Array<{ name: string }>;
  };
  changes?: {
    title?: { from: string };
  };
  label?: { name: string };
}

interface ProjectsV2ItemPayload {
  action: string;
  installation?: { id: number };
  projects_v2_item: {
    content_node_id: string;
  };
  changes?: {
    field_value?: {
      field_name: string;
      from?: string | null;
      to?: string | null;
    };
  };
}

/**
 * Validate the GitHub webhook signature using HMAC-SHA256.
 */
async function verifySignature(
  body: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature || !signature.startsWith('sha256=')) {
    return false;
  }

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const expected = new Uint8Array(mac);
  const received = hexToBytes(signature.slice(7));
  if (!received) return false;
  if (expected.length !== received.length) return false;

  // Constant-time comparison
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected[i] ^ received[i];
  }
  return result === 0;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// ── Task Group Creation ──────────────────────────────────────────

/**
 * Get per-agent prompt for a given slot index.
 * Task i → agents[i].prompt ?? feature.prompt
 */
function getAgentPrompt(feature: FeatureConfig, index: number): string {
  return feature.agents?.[index]?.prompt ?? feature.prompt;
}

/**
 * Get per-agent task_type: if agentCount > 1, worker tasks are 'review';
 * if agentCount == 1, the single task is 'summary'.
 */
function getTaskRole(agentCount: number): TaskRole {
  return agentCount > 1 ? 'review' : 'summary';
}

/**
 * Maps feature types to their specific TaskRole values.
 * Features not in this map use getTaskRole(agentCount) for review/summary.
 */
const FEATURE_ROLE_MAP: Partial<Record<Feature, TaskRole>> = {
  dedup_pr: 'pr_dedup',
  dedup_issue: 'issue_dedup',
  triage: 'issue_triage',
  implement: 'implement',
  fix: 'fix',
};

/**
 * Build a base ReviewTask template with common fields. Caller fills in
 * task-specific fields (id, prompt, task_type, feature, group_id).
 */
function buildBaseTask(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  prUrl: string,
  diffUrl: string,
  baseRef: string,
  headRef: string,
  config: ReviewConfig,
  isPrivate: boolean,
  timeoutMs: number,
  diffSize?: number,
): Omit<ReviewTask, 'id' | 'prompt' | 'task_type' | 'feature' | 'group_id'> {
  const agentCount = config.agentCount;
  return {
    owner,
    repo,
    pr_number: prNumber,
    pr_url: prUrl,
    diff_url: diffUrl,
    base_ref: baseRef,
    head_ref: headRef,
    review_count: agentCount,
    timeout_at: Date.now() + timeoutMs,
    status: 'pending',
    queue: agentCount > 1 ? 'review' : 'summary',
    github_installation_id: installationId,
    private: isPrivate,
    config,
    created_at: Date.now(),
    ...(diffSize !== undefined ? { diff_size: diffSize } : {}),
  };
}

/**
 * Create a group of tasks for a feature pipeline.
 *
 * Uses createTaskIfNotExists for the first task (idempotency guard), then
 * createTask for remaining tasks. Returns the group_id if the group was
 * created, or null if a duplicate exists.
 *
 * When `skipDedup` is true, all tasks are created with createTask (no dedup check).
 * Use this for secondary groups in the same webhook event (e.g., dedup group alongside
 * review group) where the primary group already guards against duplicate webhooks.
 */
export async function createTaskGroup(
  store: DataStore,
  feature: Feature,
  featureConfig: FeatureConfig,
  baseTask: Omit<ReviewTask, 'id' | 'prompt' | 'task_type' | 'feature' | 'group_id'>,
  logger: Logger,
  extraFields?: Partial<ReviewTask>,
  skipDedup?: boolean,
): Promise<string | null> {
  const agentCount = featureConfig.agentCount;
  const taskCount = agentCount > 1 ? agentCount - 1 : 1;
  const role = FEATURE_ROLE_MAP[feature] ?? getTaskRole(agentCount);
  const groupId = crypto.randomUUID();
  const timeoutMs = parseTimeoutMs(featureConfig.timeout);

  // Phase 1: Build all tasks up front (validate prompts before any DB writes)
  const tasks: ReviewTask[] = [];
  for (let i = 0; i < taskCount; i++) {
    const prompt = getAgentPrompt(featureConfig, i);

    if (prompt.length > MAX_PROMPT_LENGTH) {
      logger.warn('Prompt exceeds MAX_PROMPT_LENGTH — skipping task group creation', {
        feature,
        promptLength: prompt.length,
        maxLength: MAX_PROMPT_LENGTH,
        slotIndex: i,
      });
      return null;
    }

    tasks.push({
      ...baseTask,
      id: crypto.randomUUID(),
      prompt,
      task_type: role,
      feature,
      group_id: groupId,
      timeout_at: Date.now() + timeoutMs,
      ...extraFields,
    });
  }

  // Phase 2: Dedup check, then batch-insert all tasks
  if (!skipDedup) {
    const created = await store.createTaskIfNotExists(tasks[0]);
    if (!created) {
      logger.info('Task group already exists — skipping', {
        feature,
        owner: baseTask.owner,
        repo: baseTask.repo,
        prNumber: baseTask.pr_number,
      });
      return null;
    }
    // First task already inserted by createTaskIfNotExists; batch the rest
    if (tasks.length > 1) {
      await store.createTaskBatch(tasks.slice(1));
    }
  } else {
    await store.createTaskBatch(tasks);
  }

  logger.info('Task group created', {
    groupId,
    feature,
    taskCount,
    role,
    owner: baseTask.owner,
    repo: baseTask.repo,
    prNumber: baseTask.pr_number,
  });
  return groupId;
}

/**
 * Create review task group for a PR.
 * Returns the group_id if created, null if duplicate.
 *
 * @deprecated Use createTaskGroup directly — kept for backward compatibility
 * with existing tests.
 */
export async function createTaskForPR(
  store: DataStore,
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  prUrl: string,
  diffUrl: string,
  baseRef: string,
  headRef: string,
  config: ReviewConfig,
  isPrivate: boolean,
  logger: Logger,
  diffSize?: number,
): Promise<string | null> {
  const timeoutMs = parseTimeoutMs(config.timeout);
  const baseTask = buildBaseTask(
    installationId,
    owner,
    repo,
    prNumber,
    prUrl,
    diffUrl,
    baseRef,
    headRef,
    config,
    isPrivate,
    timeoutMs,
    diffSize,
  );
  return createTaskGroup(store, 'review', config, baseTask, logger);
}

/**
 * Create all task groups for a PR event: review + optional dedup.prs.
 */
async function createPrTaskGroups(
  store: DataStore,
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  prUrl: string,
  diffUrl: string,
  baseRef: string,
  headRef: string,
  fullConfig: OpenCaraConfig,
  isPrivate: boolean,
  logger: Logger,
  diffSize?: number,
): Promise<void> {
  const reviewConfig = fullConfig.review ?? DEFAULT_REVIEW_CONFIG;
  const timeoutMs = parseTimeoutMs(reviewConfig.timeout);
  const baseTask = buildBaseTask(
    installationId,
    owner,
    repo,
    prNumber,
    prUrl,
    diffUrl,
    baseRef,
    headRef,
    reviewConfig,
    isPrivate,
    timeoutMs,
    diffSize,
  );

  // Review task group (primary — uses createTaskIfNotExists for idempotency)
  const reviewGroupId = await createTaskGroup(store, 'review', reviewConfig, baseTask, logger);

  // Only create secondary groups if the primary group was created
  // (if it returned null, a duplicate webhook already created the groups)
  if (reviewGroupId === null) return;

  // Dedup PR task group (secondary — skipDedup since review group already guards)
  if (fullConfig.dedup?.prs?.enabled) {
    const dedupConfig = fullConfig.dedup.prs;
    await createTaskGroup(
      store,
      'dedup_pr',
      dedupConfig,
      baseTask,
      logger,
      dedupConfig.indexIssue !== undefined
        ? { index_issue_number: dedupConfig.indexIssue }
        : undefined,
      true, // skipDedup — review group is the idempotency guard
    );
  }
}

/**
 * Create task groups for an issue event: triage + dedup.issues.
 */
async function createIssueTaskGroups(
  store: DataStore,
  installationId: number,
  owner: string,
  repo: string,
  issue: IssuePayload['issue'],
  fullConfig: OpenCaraConfig,
  reviewConfig: ReviewConfig,
  isPrivate: boolean,
  action: string,
  logger: Logger,
): Promise<void> {
  // Base task template for issue tasks (pr_number = 0, no diff)
  const baseTask: Omit<ReviewTask, 'id' | 'prompt' | 'task_type' | 'feature' | 'group_id'> = {
    owner,
    repo,
    pr_number: 0,
    pr_url: '',
    diff_url: '',
    base_ref: '',
    head_ref: '',
    review_count: 1,
    timeout_at: Date.now() + 10 * 60 * 1000,
    status: 'pending',
    queue: 'summary',
    github_installation_id: installationId,
    private: isPrivate,
    config: reviewConfig,
    created_at: Date.now(),
  };

  const issueFields: Partial<ReviewTask> = {
    issue_number: issue.number,
    issue_url: issue.html_url,
    issue_title: issue.title,
    issue_body: issue.body ?? undefined,
    issue_author: issue.user.login,
  };

  // Create issue task groups. The first group uses createTaskIfNotExists
  // for idempotency; subsequent groups skip dedup (the primary guards).
  let primaryCreated = false;

  // Triage task group (event trigger)
  if (
    fullConfig.triage?.enabled &&
    isEventTriggerEnabled(fullConfig.triage.trigger) &&
    fullConfig.triage.trigger.events!.includes(action)
  ) {
    const groupId = await createTaskGroup(
      store,
      'triage',
      fullConfig.triage,
      baseTask,
      logger,
      issueFields,
      primaryCreated, // false on first call → uses createTaskIfNotExists
    );
    if (groupId !== null) primaryCreated = true;
    else return; // Duplicate webhook — skip all remaining groups
  }

  // Dedup issue task group
  if (fullConfig.dedup?.issues?.enabled) {
    const dedupIssueConfig = fullConfig.dedup.issues;
    await createTaskGroup(
      store,
      'dedup_issue',
      dedupIssueConfig,
      baseTask,
      logger,
      {
        ...issueFields,
        ...(dedupIssueConfig.indexIssue !== undefined
          ? { index_issue_number: dedupIssueConfig.indexIssue }
          : {}),
      },
      primaryCreated, // true if triage group was created → skip dedup
    );
  }
}

// ── Webhook Routes ───────────────────────────────────────────────

export function webhookRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  app.post('/webhook/github', rateLimitByIP({ maxRequests: 60, windowMs: 60_000 }), async (c) => {
    const store = c.get('store');
    const github = c.get('github');
    const logger = c.get('logger');
    const body = await c.req.text();
    const signature = c.req.header('X-Hub-Signature-256') ?? null;

    const valid = await verifySignature(body, signature, c.env.GITHUB_WEBHOOK_SECRET);
    if (!valid) {
      return apiError(c, 401, 'UNAUTHORIZED', 'Invalid webhook signature');
    }

    const event = c.req.header('X-GitHub-Event');
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return apiError(c, 400, 'INVALID_REQUEST', 'Malformed request body');
    }

    const action = typeof payload.action === 'string' ? payload.action : '';

    switch (event) {
      case 'pull_request':
        return handlePullRequest(
          github,
          store,
          payload as unknown as PullRequestPayload,
          action,
          logger,
        );
      case 'issues':
        return handleIssueEvent(github, store, payload as unknown as IssuePayload, action, logger);
      case 'issue_comment':
        if (action === 'created') {
          return handleIssueComment(
            github,
            store,
            payload as unknown as IssueCommentPayload,
            logger,
          );
        }
        break;
      case 'projects_v2_item':
        if (action === 'edited') {
          return handleProjectsV2Item(
            github,
            store,
            payload as unknown as ProjectsV2ItemPayload,
            logger,
          );
        }
        break;
      case 'installation':
        logger.info('Installation event', { action });
        break;
    }

    return c.text('OK', 200);
  });

  return app;
}

async function handlePullRequest(
  github: GitHubService,
  store: DataStore,
  payload: PullRequestPayload,
  action: string,
  logger: Logger,
): Promise<Response> {
  const { installation, repository, pull_request } = payload;

  if (!installation) {
    logger.info('PR event without installation — skipping');
    return new Response('OK', { status: 200 });
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const prNumber = pull_request.number;
  const headRef = pull_request.head.ref;

  logger.info('Webhook received', {
    event: 'pull_request',
    owner,
    repo,
    prNumber,
    action,
    headRef,
  });

  let token: string;
  try {
    token = await github.getInstallationToken(installation.id);
  } catch (err) {
    logger.error('Failed to get installation token', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response('Service Unavailable', { status: 503 });
  }

  const baseRef = pull_request.base.ref;
  const { config: fullConfig, parseError } = await github.loadOpenCaraConfig(
    owner,
    repo,
    baseRef,
    token,
  );

  if (parseError) {
    logger.info('Aborting due to .opencara.toml parse error', { prNumber });
    return new Response('Service Unavailable', { status: 503 });
  }

  const reviewConfig = fullConfig.review ?? DEFAULT_REVIEW_CONFIG;

  // Handle PR close/merge — move dedup index entries + clean up pending tasks
  if (action === 'closed') {
    await handlePrClose(github, owner, repo, prNumber, fullConfig, token, logger);
    try {
      const deleted = await store.deletePendingTasksByPr(owner, repo, prNumber);
      if (deleted > 0) {
        logger.info('Cleaned up pending tasks on PR close', { owner, repo, prNumber, deleted });
      }
    } catch (err) {
      logger.error('Failed to clean up pending tasks on PR close', {
        error: err instanceof Error ? err.message : String(err),
        owner,
        repo,
        prNumber,
      });
    }
    return new Response('OK', { status: 200 });
  }

  // Handle PR edited — update dedup index entry title
  if (action === 'edited') {
    const oldTitle = payload.changes?.title?.from;
    if (oldTitle) {
      await handlePrIndexUpdate(github, owner, repo, prNumber, fullConfig, token, logger, {
        newTitle: pull_request.title,
        oldTitle,
        labels: pull_request.labels?.map((l) => l.name),
      });
    }
    // Fall through to event-based triggers (edited may also trigger review)
  }

  // Handle PR unlabeled — update dedup index entry labels
  if (action === 'unlabeled') {
    await handlePrIndexUpdate(github, owner, repo, prNumber, fullConfig, token, logger, {
      labels: pull_request.labels?.map((l) => l.name),
    });
    return new Response('OK', { status: 200 });
  }

  // Handle label triggers for PR-scoped features (review, fix)
  if (action === 'labeled') {
    // Update dedup index entry labels
    await handlePrIndexUpdate(github, owner, repo, prNumber, fullConfig, token, logger, {
      labels: pull_request.labels?.map((l) => l.name),
    });

    const addedLabel = payload.label?.name;
    if (addedLabel) {
      return handlePrLabelTrigger(
        store,
        installation.id,
        owner,
        repo,
        pull_request,
        fullConfig,
        reviewConfig,
        addedLabel,
        repository.private ?? false,
        logger,
      );
    }
    return new Response('OK', { status: 200 });
  }

  // Event-based triggers for review
  const reviewTrigger = reviewConfig.trigger;
  if (!isEventTriggerEnabled(reviewTrigger) || !reviewTrigger.events!.includes(action)) {
    logger.info('Action not in trigger.events — skipping', {
      prNumber,
      action,
      triggerEvents: reviewTrigger.events,
    });
    return new Response('OK', { status: 200 });
  }

  const skipReason = shouldSkipReview(reviewConfig, {
    draft: pull_request.draft,
    labels: pull_request.labels,
    headRef,
  });
  if (skipReason) {
    logger.info('PR skipped', { prNumber, reason: skipReason });
    return new Response('OK', { status: 200 });
  }

  // Compute diff size from webhook payload (additions + deletions)
  const diffSize =
    typeof pull_request.additions === 'number' && typeof pull_request.deletions === 'number'
      ? pull_request.additions + pull_request.deletions
      : undefined;

  try {
    await createPrTaskGroups(
      store,
      installation.id,
      owner,
      repo,
      prNumber,
      pull_request.html_url,
      pull_request.diff_url,
      pull_request.base.ref,
      headRef,
      fullConfig,
      repository.private ?? false,
      logger,
      diffSize,
    );
  } catch (err) {
    logger.error('Failed to create task groups for PR', {
      error: err instanceof Error ? err.message : String(err),
      owner,
      repo,
      prNumber,
    });
    return new Response('Service Unavailable', { status: 503 });
  }

  return new Response('OK', { status: 200 });
}

/**
 * Handle GitHub `issues` webhook event.
 * Creates triage and/or dedup task groups for new or edited issues.
 */
export async function handleIssueEvent(
  github: GitHubService,
  store: DataStore,
  payload: IssuePayload,
  action: string,
  logger: Logger,
): Promise<Response> {
  const { installation, repository, issue } = payload;

  if (!installation) {
    logger.info('Issue event without installation — skipping');
    return new Response('OK', { status: 200 });
  }

  // Skip issue events for pull requests (GitHub sends issues events for PRs too)
  if (issue.pull_request) {
    logger.info('Issue event is a PR — skipping', { issueNumber: issue.number });
    return new Response('OK', { status: 200 });
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const defaultBranch = repository.default_branch ?? 'main';

  logger.info('Webhook received', {
    event: 'issues',
    owner,
    repo,
    issueNumber: issue.number,
    action,
  });

  // Handle issue close — move dedup index entries + clean up pending tasks
  if (action === 'closed') {
    let token: string;
    try {
      token = await github.getInstallationToken(installation.id);
    } catch (err) {
      logger.error('Failed to get installation token', {
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response('Service Unavailable', { status: 503 });
    }

    const { config: fullConfig, parseError } = await github.loadOpenCaraConfig(
      owner,
      repo,
      defaultBranch,
      token,
    );

    if (!parseError) {
      await handleIssueClose(github, owner, repo, issue.number, fullConfig, token, logger);
    }

    try {
      const deleted = await store.deletePendingTasksByIssue(owner, repo, issue.number);
      if (deleted > 0) {
        logger.info('Cleaned up pending tasks on issue close', {
          owner,
          repo,
          issueNumber: issue.number,
          deleted,
        });
      }
    } catch (err) {
      logger.error('Failed to clean up pending tasks on issue close', {
        error: err instanceof Error ? err.message : String(err),
        owner,
        repo,
        issueNumber: issue.number,
      });
    }

    return new Response('OK', { status: 200 });
  }

  // Handle issue unlabeled — update dedup index entry labels
  if (action === 'unlabeled') {
    let token: string;
    try {
      token = await github.getInstallationToken(installation.id);
    } catch (err) {
      logger.error('Failed to get installation token', {
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response('Service Unavailable', { status: 503 });
    }

    const { config: fullConfig, parseError } = await github.loadOpenCaraConfig(
      owner,
      repo,
      defaultBranch,
      token,
    );

    if (!parseError) {
      await handleIssueIndexUpdate(github, owner, repo, issue.number, fullConfig, token, logger, {
        labels: issue.labels?.map((l) => l.name),
      });
    }
    return new Response('OK', { status: 200 });
  }

  // Handle label trigger for issue-scoped features (implement, triage)
  if (action === 'labeled') {
    const addedLabel = payload.label?.name;
    if (!addedLabel) return new Response('OK', { status: 200 });

    let token: string;
    try {
      token = await github.getInstallationToken(installation.id);
    } catch (err) {
      logger.error('Failed to get installation token', {
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response('Service Unavailable', { status: 503 });
    }

    const { config: fullConfig, parseError } = await github.loadOpenCaraConfig(
      owner,
      repo,
      defaultBranch,
      token,
    );

    if (parseError) {
      logger.info('Aborting due to .opencara.toml parse error', { issueNumber: issue.number });
      return new Response('Service Unavailable', { status: 503 });
    }

    // Update dedup index entry labels
    await handleIssueIndexUpdate(github, owner, repo, issue.number, fullConfig, token, logger, {
      labels: issue.labels?.map((l) => l.name),
    });

    return handleIssueLabelTrigger(
      github,
      store,
      installation.id,
      owner,
      repo,
      issue,
      fullConfig,
      addedLabel,
      repository.private ?? false,
      token,
      logger,
    );
  }

  if (action !== 'opened' && action !== 'edited') {
    logger.info('Issue action not handled — skipping', { action, issueNumber: issue.number });
    return new Response('OK', { status: 200 });
  }

  let token: string;
  try {
    token = await github.getInstallationToken(installation.id);
  } catch (err) {
    logger.error('Failed to get installation token', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response('Service Unavailable', { status: 503 });
  }

  const { config: fullConfig, parseError } = await github.loadOpenCaraConfig(
    owner,
    repo,
    defaultBranch,
    token,
  );

  if (parseError) {
    logger.info('Aborting due to .opencara.toml parse error', {
      issueNumber: issue.number,
    });
    return new Response('Service Unavailable', { status: 503 });
  }

  // Update dedup index on title change for edited issues
  if (action === 'edited') {
    const oldTitle = payload.changes?.title?.from;
    if (oldTitle) {
      await handleIssueIndexUpdate(github, owner, repo, issue.number, fullConfig, token, logger, {
        newTitle: issue.title,
        oldTitle,
        labels: issue.labels?.map((l) => l.name),
      });
    }
  }

  const reviewConfig = fullConfig.review ?? DEFAULT_REVIEW_CONFIG;

  // Check if any feature is enabled for issues via event triggers
  const triageEnabled =
    fullConfig.triage?.enabled &&
    isEventTriggerEnabled(fullConfig.triage.trigger) &&
    fullConfig.triage.trigger.events!.includes(action);
  const dedupIssuesEnabled = fullConfig.dedup?.issues?.enabled;

  if (!triageEnabled && !dedupIssuesEnabled) {
    logger.info('No issue features enabled — skipping', {
      issueNumber: issue.number,
    });
    return new Response('OK', { status: 200 });
  }

  try {
    await createIssueTaskGroups(
      store,
      installation.id,
      owner,
      repo,
      issue,
      fullConfig,
      reviewConfig,
      repository.private ?? false,
      action,
      logger,
    );
  } catch (err) {
    logger.error('Failed to create task groups for issue', {
      error: err instanceof Error ? err.message : String(err),
      owner,
      repo,
      issueNumber: issue.number,
    });
    return new Response('Service Unavailable', { status: 503 });
  }

  return new Response('OK', { status: 200 });
}

// ── Index Lifecycle on Close ─────────────────────────────────────

/**
 * Handle dedup index update when a PR is closed/merged.
 * Moves the PR entry from Open → Recently Closed, then runs age-out.
 */
async function handlePrClose(
  github: GitHubService,
  owner: string,
  repo: string,
  prNumber: number,
  config: OpenCaraConfig,
  token: string,
  logger: Logger,
): Promise<void> {
  const indexIssue = config.dedup?.prs?.indexIssue;
  if (!indexIssue || !config.dedup?.prs?.enabled) return;

  try {
    await moveToRecentlyClosed(github, owner, repo, indexIssue, prNumber, token, logger);
    await ageOutToArchived(github, owner, repo, indexIssue, token, logger);
  } catch (err) {
    logger.error('Failed to update dedup index on PR close', {
      error: err instanceof Error ? err.message : String(err),
      owner,
      repo,
      prNumber,
      indexIssue,
    });
  }
}

/**
 * Handle dedup index update when an issue is closed.
 * Moves the issue entry from Open → Recently Closed, then runs age-out.
 */
async function handleIssueClose(
  github: GitHubService,
  owner: string,
  repo: string,
  issueNumber: number,
  config: OpenCaraConfig,
  token: string,
  logger: Logger,
): Promise<void> {
  const indexIssue = config.dedup?.issues?.indexIssue;
  if (!indexIssue || !config.dedup?.issues?.enabled) return;

  try {
    await moveToRecentlyClosed(github, owner, repo, indexIssue, issueNumber, token, logger);
    await ageOutToArchived(github, owner, repo, indexIssue, token, logger);
  } catch (err) {
    logger.error('Failed to update dedup index on issue close', {
      error: err instanceof Error ? err.message : String(err),
      owner,
      repo,
      issueNumber,
      indexIssue,
    });
  }
}

// ── Index Update on Edit/Label Change ───────────────────────────

/**
 * Handle dedup index update when a PR's title or labels change.
 */
async function handlePrIndexUpdate(
  github: GitHubService,
  owner: string,
  repo: string,
  prNumber: number,
  config: OpenCaraConfig,
  token: string,
  logger: Logger,
  update: { labels?: string[]; newTitle?: string; oldTitle?: string },
): Promise<void> {
  const indexIssue = config.dedup?.prs?.indexIssue;
  if (!indexIssue || !config.dedup?.prs?.enabled) return;

  try {
    await updateOpenEntry(github, owner, repo, indexIssue, prNumber, token, logger, update);
  } catch (err) {
    logger.error('Failed to update dedup index on PR edit', {
      error: err instanceof Error ? err.message : String(err),
      owner,
      repo,
      prNumber,
      indexIssue,
    });
  }
}

/**
 * Handle dedup index update when an issue's title or labels change.
 */
async function handleIssueIndexUpdate(
  github: GitHubService,
  owner: string,
  repo: string,
  issueNumber: number,
  config: OpenCaraConfig,
  token: string,
  logger: Logger,
  update: { labels?: string[]; newTitle?: string; oldTitle?: string },
): Promise<void> {
  const indexIssue = config.dedup?.issues?.indexIssue;
  if (!indexIssue || !config.dedup?.issues?.enabled) return;

  try {
    await updateOpenEntry(github, owner, repo, indexIssue, issueNumber, token, logger, update);
  } catch (err) {
    logger.error('Failed to update dedup index on issue edit', {
      error: err instanceof Error ? err.message : String(err),
      owner,
      repo,
      issueNumber,
      indexIssue,
    });
  }
}

/**
 * Parse a fix command from a comment body.
 * Matches `/opencara fix [model]` or `@opencara fix [model]`.
 * Returns the optional target model, or null if not a fix command.
 */
export function parseFixCommand(body: string): { targetModel?: string } | null {
  const trimmed = body.trim();
  // Match /opencara fix or @opencara fix (case-insensitive), optional model after
  const match = trimmed.match(/^[/@]opencara\s+fix(?:\s+(\S+))?\s*$/i);
  if (!match) return null;
  return { targetModel: match[1] || undefined };
}

/**
 * Parse a go command from a comment body.
 * Matches `/opencara go [model]` or `@opencara go [model]`.
 * Returns the optional target model, or null if not a go command.
 */
export function parseGoCommand(body: string): { targetModel?: string } | null {
  const trimmed = body.trim();
  // Match /opencara go or @opencara go (case-insensitive), optional model after
  const match = trimmed.match(/^[/@]opencara\s+go(?:\s+(\S+))?\s*$/i);
  if (!match) return null;
  return { targetModel: match[1] || undefined };
}

/**
 * Parse a triage command from a comment body.
 * Matches `/opencara triage [model]` or `@opencara triage [model]`.
 * Returns the optional target model, or null if not a triage command.
 */
export function parseTriageCommand(body: string): { targetModel?: string } | null {
  const trimmed = body.trim();
  const match = trimmed.match(/^[/@]opencara\s+triage(?:\s+(\S+))?\s*$/i);
  if (!match) return null;
  return { targetModel: match[1] || undefined };
}

async function handleIssueComment(
  github: GitHubService,
  store: DataStore,
  payload: IssueCommentPayload,
  logger: Logger,
): Promise<Response> {
  const { installation, repository, issue, comment } = payload;

  if (!installation) {
    logger.info('Comment event without installation — skipping');
    return new Response('OK', { status: 200 });
  }

  // Issue-only commands: go and triage (not valid on PRs)
  if (!issue.pull_request) {
    const goCmd = parseGoCommand(comment.body);
    if (goCmd) {
      return handleGoCommand(
        github,
        store,
        installation.id,
        repository.owner.login,
        repository.name,
        issue.number,
        repository.default_branch ?? 'main',
        comment,
        goCmd,
        repository.private ?? false,
        logger,
      );
    }

    const triageCmd = parseTriageCommand(comment.body);
    if (triageCmd) {
      return handleTriageCommand(
        github,
        store,
        installation.id,
        repository.owner.login,
        repository.name,
        issue.number,
        repository.default_branch ?? 'main',
        comment,
        triageCmd,
        repository.private ?? false,
        logger,
      );
    }

    return new Response('OK', { status: 200 });
  }

  // Check for go command — invalid on PRs, skip silently
  if (parseGoCommand(comment.body)) {
    return new Response('OK', { status: 200 });
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const prNumber = issue.number;

  let token: string;
  try {
    token = await github.getInstallationToken(installation.id);
  } catch (err) {
    logger.error('Failed to get installation token', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response('Service Unavailable', { status: 503 });
  }

  const pr = await github.fetchPrDetails(owner, repo, prNumber, token);
  if (!pr) {
    logger.error('Failed to fetch PR details', { owner, repo, prNumber });
    return new Response('Service Unavailable', { status: 503 });
  }

  const { config: fullConfig, parseError: fullParseError } = await github.loadOpenCaraConfig(
    owner,
    repo,
    pr.base.ref,
    token,
  );

  if (fullParseError) {
    logger.info('Aborting comment trigger due to .opencara.toml parse error', {
      owner,
      repo,
      prNumber,
    });
    return new Response('Service Unavailable', { status: 503 });
  }

  const reviewConfig = fullConfig.review ?? DEFAULT_REVIEW_CONFIG;

  // Check for fix command first
  const fixCmd = parseFixCommand(comment.body);
  if (fixCmd) {
    return handleFixCommand(
      github,
      store,
      installation.id,
      owner,
      repo,
      prNumber,
      pr,
      fullConfig,
      reviewConfig,
      comment,
      fixCmd,
      repository.private ?? false,
      token,
      logger,
    );
  }

  // Check for review trigger command (gated by isCommentTriggerEnabled)
  if (!isCommentTriggerEnabled(reviewConfig.trigger)) {
    return new Response('OK', { status: 200 });
  }
  const triggerCommand = reviewConfig.trigger.comment!;
  const body = comment.body.trim().toLowerCase();
  const cmd = triggerCommand.toLowerCase();
  // Only slash-commands get an @-alias (e.g. /opencara review → @opencara review).
  // Bare-word triggers (e.g. "review") intentionally do not generate an @-variant.
  const atVariant = cmd.startsWith('/') ? '@' + cmd.slice(1) : null;
  const triggered = body.startsWith(cmd) || (atVariant !== null && body.startsWith(atVariant));
  if (!triggered) {
    return new Response('OK', { status: 200 });
  }

  if (!TRUSTED_ASSOCIATIONS.has(comment.author_association)) {
    logger.info('Trigger command ignored — not a trusted contributor', {
      command: triggerCommand,
      user: comment.user.login,
      association: comment.author_association,
    });
    return new Response('OK', { status: 200 });
  }

  logger.info('Trigger command received', {
    command: triggerCommand,
    user: comment.user.login,
    owner,
    repo,
    prNumber,
  });

  // Compute diff size from PR details (additions + deletions)
  const commentDiffSize =
    typeof pr.additions === 'number' && typeof pr.deletions === 'number'
      ? pr.additions + pr.deletions
      : undefined;

  try {
    await createTaskForPR(
      store,
      installation.id,
      owner,
      repo,
      prNumber,
      pr.html_url,
      pr.diff_url,
      pr.base.ref,
      pr.head.ref,
      reviewConfig,
      repository.private ?? false,
      logger,
      commentDiffSize,
    );
  } catch (err) {
    logger.error('Failed to create task for PR', {
      error: err instanceof Error ? err.message : String(err),
      owner,
      repo,
      prNumber,
    });
    return new Response('Service Unavailable', { status: 503 });
  }

  return new Response('OK', { status: 200 });
}

/**
 * Handle `/opencara fix [model]` command on a PR comment.
 * Creates a fix task group with PR review comments.
 */
async function handleFixCommand(
  github: GitHubService,
  store: DataStore,
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  pr: NonNullable<Awaited<ReturnType<GitHubService['fetchPrDetails']>>>,
  fullConfig: OpenCaraConfig,
  reviewConfig: ReviewConfig,
  comment: IssueCommentPayload['comment'],
  fixCmd: { targetModel?: string },
  isPrivate: boolean,
  token: string,
  logger: Logger,
): Promise<Response> {
  const isMaintainer = MAINTAINER_ASSOCIATIONS.has(comment.author_association);
  const isPrAuthor = comment.user.login.toLowerCase() === pr.user.login.toLowerCase();
  if (!isMaintainer && !isPrAuthor) {
    logger.info('Fix command ignored — not a maintainer or PR author', {
      user: comment.user.login,
      association: comment.author_association,
      prAuthor: pr.user.login,
    });
    return new Response('OK', { status: 200 });
  }

  if (!fullConfig.fix?.enabled) {
    logger.info('Fix command ignored — [fix].enabled is not true', {
      owner,
      repo,
      prNumber,
    });
    return new Response('OK', { status: 200 });
  }

  if (!isCommentTriggerEnabled(fullConfig.fix.trigger)) {
    logger.info('Fix command ignored — comment trigger not enabled', {
      owner,
      repo,
      prNumber,
    });
    return new Response('OK', { status: 200 });
  }

  logger.info('Fix command received', {
    user: comment.user.login,
    owner,
    repo,
    prNumber,
    targetModel: fixCmd.targetModel,
  });

  // Fetch PR review comments (truncate to 64KB to bound task size)
  let prReviewComments = '';
  try {
    prReviewComments = await github.fetchPrReviewComments(owner, repo, prNumber, token);
    if (prReviewComments.length > MAX_REVIEW_COMMENTS_LENGTH) {
      logger.warn('PR review comments truncated', {
        originalLength: prReviewComments.length,
        maxLength: MAX_REVIEW_COMMENTS_LENGTH,
        owner,
        repo,
        prNumber,
      });
      prReviewComments = prReviewComments.slice(0, MAX_REVIEW_COMMENTS_LENGTH);
    }
  } catch (err) {
    logger.warn('Failed to fetch PR review comments', {
      error: err instanceof Error ? err.message : String(err),
      owner,
      repo,
      prNumber,
    });
  }

  const fixConfig = fullConfig.fix;
  const timeoutMs = parseTimeoutMs(fixConfig.timeout);
  // Merge fix feature preferences into a ReviewConfig so the stored task.config
  // reflects the fix section's preferred models/tools (used for poll matching).
  const fixTaskConfig: ReviewConfig = {
    ...reviewConfig,
    agentCount: fixConfig.agentCount,
    timeout: fixConfig.timeout,
    preferredModels: fixConfig.preferredModels,
    preferredTools: fixConfig.preferredTools,
    prompt: fixConfig.prompt,
    modelDiversityGraceMs: fixConfig.modelDiversityGraceMs,
  };
  // Compute diff size from PR details (additions + deletions)
  const fixDiffSize =
    typeof pr.additions === 'number' && typeof pr.deletions === 'number'
      ? pr.additions + pr.deletions
      : undefined;
  const baseTask = buildBaseTask(
    installationId,
    owner,
    repo,
    prNumber,
    pr.html_url,
    pr.diff_url,
    pr.base.ref,
    pr.head.ref,
    fixTaskConfig,
    isPrivate,
    timeoutMs,
    fixDiffSize,
  );

  try {
    await createTaskGroup(store, 'fix', fixConfig, baseTask, logger, {
      pr_review_comments: prReviewComments,
      head_sha: pr.head.sha,
      ...(fixCmd.targetModel ? { target_model: fixCmd.targetModel } : {}),
    });
  } catch (err) {
    logger.error('Failed to create fix task group', {
      error: err instanceof Error ? err.message : String(err),
      owner,
      repo,
      prNumber,
    });
    return new Response('Service Unavailable', { status: 503 });
  }

  return new Response('OK', { status: 200 });
}

/**
 * Handle `/opencara go [model]` command on an issue comment.
 * Creates an implement task group with issue context.
 */
async function handleGoCommand(
  github: GitHubService,
  store: DataStore,
  installationId: number,
  owner: string,
  repo: string,
  issueNumber: number,
  defaultBranch: string,
  comment: IssueCommentPayload['comment'],
  goCmd: { targetModel?: string },
  isPrivate: boolean,
  logger: Logger,
): Promise<Response> {
  if (!MAINTAINER_ASSOCIATIONS.has(comment.author_association)) {
    logger.info('Go command ignored — not a maintainer', {
      user: comment.user.login,
      association: comment.author_association,
    });
    return new Response('OK', { status: 200 });
  }

  logger.info('Go command received', {
    user: comment.user.login,
    owner,
    repo,
    issueNumber,
    targetModel: goCmd.targetModel,
  });

  let token: string;
  try {
    token = await github.getInstallationToken(installationId);
  } catch (err) {
    logger.error('Failed to get installation token', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response('Service Unavailable', { status: 503 });
  }

  const { config: fullConfig, parseError } = await github.loadOpenCaraConfig(
    owner,
    repo,
    defaultBranch,
    token,
  );

  if (parseError) {
    logger.info('Aborting go command due to .opencara.toml parse error', {
      owner,
      repo,
      issueNumber,
    });
    return new Response('Service Unavailable', { status: 503 });
  }

  if (!fullConfig.implement?.enabled) {
    logger.info('Go command ignored — [implement].enabled is not true', {
      owner,
      repo,
      issueNumber,
    });
    return new Response('OK', { status: 200 });
  }

  if (!isCommentTriggerEnabled(fullConfig.implement.trigger)) {
    logger.info('Go command ignored — comment trigger not enabled', {
      owner,
      repo,
      issueNumber,
    });
    return new Response('OK', { status: 200 });
  }

  // Fetch issue details from GitHub API
  let issue: Awaited<ReturnType<GitHubService['fetchIssueDetails']>>;
  try {
    issue = await github.fetchIssueDetails(owner, repo, issueNumber, token);
  } catch (err) {
    logger.error('Failed to fetch issue details', {
      error: err instanceof Error ? err.message : String(err),
      owner,
      repo,
      issueNumber,
    });
    return new Response('Service Unavailable', { status: 503 });
  }
  if (!issue) {
    logger.error('Issue not found', { owner, repo, issueNumber });
    return new Response('Service Unavailable', { status: 503 });
  }

  const implementConfig = fullConfig.implement;
  const reviewConfig = fullConfig.review ?? DEFAULT_REVIEW_CONFIG;
  const timeoutMs = parseTimeoutMs(implementConfig.timeout);

  // Merge implement feature preferences into a ReviewConfig so the stored task.config
  // reflects the implement section's preferred models/tools (used for poll matching).
  const implementTaskConfig: ReviewConfig = {
    ...reviewConfig,
    agentCount: implementConfig.agentCount,
    timeout: implementConfig.timeout,
    preferredModels: implementConfig.preferredModels,
    preferredTools: implementConfig.preferredTools,
    prompt: implementConfig.prompt,
    modelDiversityGraceMs: implementConfig.modelDiversityGraceMs,
  };

  const baseTask: Omit<ReviewTask, 'id' | 'prompt' | 'task_type' | 'feature' | 'group_id'> = {
    owner,
    repo,
    pr_number: 0,
    pr_url: '',
    diff_url: '',
    base_ref: '',
    head_ref: '',
    review_count: implementConfig.agentCount,
    timeout_at: Date.now() + timeoutMs,
    status: 'pending',
    queue: 'summary',
    github_installation_id: installationId,
    private: isPrivate,
    config: implementTaskConfig,
    created_at: Date.now(),
  };

  try {
    await createTaskGroup(store, 'implement', implementConfig, baseTask, logger, {
      issue_number: issue.number,
      issue_url: issue.html_url,
      issue_title: issue.title,
      issue_body: issue.body ?? undefined,
      issue_author: issue.user.login,
      ...(goCmd.targetModel ? { target_model: goCmd.targetModel } : {}),
    });
  } catch (err) {
    logger.error('Failed to create implement task group', {
      error: err instanceof Error ? err.message : String(err),
      owner,
      repo,
      issueNumber,
    });
    return new Response('Service Unavailable', { status: 503 });
  }

  return new Response('OK', { status: 200 });
}

/**
 * Handle `/opencara triage [model]` command on an issue comment.
 * Creates a triage task group with issue context.
 */
async function handleTriageCommand(
  github: GitHubService,
  store: DataStore,
  installationId: number,
  owner: string,
  repo: string,
  issueNumber: number,
  defaultBranch: string,
  comment: IssueCommentPayload['comment'],
  triageCmd: { targetModel?: string },
  isPrivate: boolean,
  logger: Logger,
): Promise<Response> {
  if (!TRUSTED_ASSOCIATIONS.has(comment.author_association)) {
    logger.info('Triage command ignored — not a trusted contributor', {
      user: comment.user.login,
      association: comment.author_association,
    });
    return new Response('OK', { status: 200 });
  }

  logger.info('Triage command received', {
    user: comment.user.login,
    owner,
    repo,
    issueNumber,
    targetModel: triageCmd.targetModel,
  });

  let token: string;
  try {
    token = await github.getInstallationToken(installationId);
  } catch (err) {
    logger.error('Failed to get installation token', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response('Service Unavailable', { status: 503 });
  }

  const { config: fullConfig, parseError } = await github.loadOpenCaraConfig(
    owner,
    repo,
    defaultBranch,
    token,
  );

  if (parseError) {
    logger.info('Aborting triage command due to .opencara.toml parse error', {
      owner,
      repo,
      issueNumber,
    });
    return new Response('Service Unavailable', { status: 503 });
  }

  if (!fullConfig.triage?.enabled) {
    logger.info('Triage command ignored — [triage].enabled is not true', {
      owner,
      repo,
      issueNumber,
    });
    return new Response('OK', { status: 200 });
  }

  if (!isCommentTriggerEnabled(fullConfig.triage.trigger)) {
    logger.info('Triage command ignored — comment trigger not enabled', {
      owner,
      repo,
      issueNumber,
    });
    return new Response('OK', { status: 200 });
  }

  // Fetch issue details from GitHub API
  let issue: Awaited<ReturnType<GitHubService['fetchIssueDetails']>>;
  try {
    issue = await github.fetchIssueDetails(owner, repo, issueNumber, token);
  } catch (err) {
    logger.error('Failed to fetch issue details', {
      error: err instanceof Error ? err.message : String(err),
      owner,
      repo,
      issueNumber,
    });
    return new Response('Service Unavailable', { status: 503 });
  }
  if (!issue) {
    logger.error('Issue not found', { owner, repo, issueNumber });
    return new Response('Service Unavailable', { status: 503 });
  }

  const triageConfig = fullConfig.triage;
  const reviewConfig = fullConfig.review ?? DEFAULT_REVIEW_CONFIG;
  const timeoutMs = parseTimeoutMs(triageConfig.timeout);

  const baseTask: Omit<ReviewTask, 'id' | 'prompt' | 'task_type' | 'feature' | 'group_id'> = {
    owner,
    repo,
    pr_number: 0,
    pr_url: '',
    diff_url: '',
    base_ref: '',
    head_ref: '',
    review_count: triageConfig.agentCount,
    timeout_at: Date.now() + timeoutMs,
    status: 'pending',
    queue: 'summary',
    github_installation_id: installationId,
    private: isPrivate,
    config: reviewConfig,
    created_at: Date.now(),
  };

  try {
    await createTaskGroup(store, 'triage', triageConfig, baseTask, logger, {
      issue_number: issue.number,
      issue_url: issue.html_url,
      issue_title: issue.title,
      issue_body: issue.body ?? undefined,
      issue_author: issue.user.login,
      ...(triageCmd.targetModel ? { target_model: triageCmd.targetModel } : {}),
    });
  } catch (err) {
    logger.error('Failed to create triage task group', {
      error: err instanceof Error ? err.message : String(err),
      owner,
      repo,
      issueNumber,
    });
    return new Response('Service Unavailable', { status: 503 });
  }

  return new Response('OK', { status: 200 });
}

// ── Label Trigger Handlers ──────────────────────────────────────

/**
 * Handle label triggers on a PR: review and fix features.
 */
async function handlePrLabelTrigger(
  store: DataStore,
  installationId: number,
  owner: string,
  repo: string,
  pullRequest: PullRequestPayload['pull_request'],
  fullConfig: OpenCaraConfig,
  reviewConfig: ReviewConfig,
  addedLabel: string,
  isPrivate: boolean,
  logger: Logger,
): Promise<Response> {
  const prNumber = pullRequest.number;
  const headRef = pullRequest.head.ref;

  // Skip conditions apply to label triggers too
  const skipReason = shouldSkipReview(reviewConfig, {
    draft: pullRequest.draft,
    labels: pullRequest.labels,
    headRef,
  });
  if (skipReason) {
    logger.info('PR label trigger skipped', { prNumber, reason: skipReason });
    return new Response('OK', { status: 200 });
  }

  const diffSize =
    typeof pullRequest.additions === 'number' && typeof pullRequest.deletions === 'number'
      ? pullRequest.additions + pullRequest.deletions
      : undefined;

  const timeoutMs = parseTimeoutMs(reviewConfig.timeout);
  const baseTask = buildBaseTask(
    installationId,
    owner,
    repo,
    prNumber,
    pullRequest.html_url,
    pullRequest.diff_url,
    pullRequest.base.ref,
    headRef,
    reviewConfig,
    isPrivate,
    timeoutMs,
    diffSize,
  );

  let created = false;

  // Review label trigger
  if (isLabelTriggerEnabled(reviewConfig.trigger) && reviewConfig.trigger.label === addedLabel) {
    logger.info('Review label trigger matched', { prNumber, label: addedLabel });
    const groupId = await createTaskGroup(
      store,
      'review',
      reviewConfig,
      baseTask,
      logger,
      undefined,
      created,
    );
    if (groupId !== null) created = true;
  }

  // Fix label trigger
  if (
    fullConfig.fix?.enabled &&
    isLabelTriggerEnabled(fullConfig.fix.trigger) &&
    fullConfig.fix.trigger.label === addedLabel
  ) {
    logger.info('Fix label trigger matched', { prNumber, label: addedLabel });
    await createTaskGroup(store, 'fix', fullConfig.fix, baseTask, logger, undefined, created);
  }

  return new Response('OK', { status: 200 });
}

/**
 * Handle label triggers on an issue: implement and triage features.
 */
async function handleIssueLabelTrigger(
  github: GitHubService,
  store: DataStore,
  installationId: number,
  owner: string,
  repo: string,
  issue: IssuePayload['issue'],
  fullConfig: OpenCaraConfig,
  addedLabel: string,
  isPrivate: boolean,
  token: string,
  logger: Logger,
): Promise<Response> {
  const reviewConfig = fullConfig.review ?? DEFAULT_REVIEW_CONFIG;
  const baseTask: Omit<ReviewTask, 'id' | 'prompt' | 'task_type' | 'feature' | 'group_id'> = {
    owner,
    repo,
    pr_number: 0,
    pr_url: '',
    diff_url: '',
    base_ref: '',
    head_ref: '',
    review_count: 1,
    timeout_at: Date.now() + 10 * 60 * 1000,
    status: 'pending',
    queue: 'summary',
    github_installation_id: installationId,
    private: isPrivate,
    config: reviewConfig,
    created_at: Date.now(),
  };

  const issueFields: Partial<ReviewTask> = {
    issue_number: issue.number,
    issue_url: issue.html_url,
    issue_title: issue.title,
    issue_body: issue.body ?? undefined,
    issue_author: issue.user.login,
  };

  let created = false;

  // Implement label trigger
  if (
    fullConfig.implement?.enabled &&
    isLabelTriggerEnabled(fullConfig.implement.trigger) &&
    fullConfig.implement.trigger.label === addedLabel
  ) {
    logger.info('Implement label trigger matched', {
      issueNumber: issue.number,
      label: addedLabel,
    });

    // Fetch full issue details for implement tasks
    let issueDetails: Awaited<ReturnType<GitHubService['fetchIssueDetails']>>;
    try {
      issueDetails = await github.fetchIssueDetails(owner, repo, issue.number, token);
    } catch (err) {
      logger.error('Failed to fetch issue details for implement label trigger', {
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response('Service Unavailable', { status: 503 });
    }
    if (!issueDetails) {
      logger.error('Issue not found for implement label trigger', {
        issueNumber: issue.number,
      });
      return new Response('Service Unavailable', { status: 503 });
    }

    const implementConfig = fullConfig.implement;
    const implementTimeoutMs = parseTimeoutMs(implementConfig.timeout);
    const implementTaskConfig: ReviewConfig = {
      ...reviewConfig,
      agentCount: implementConfig.agentCount,
      timeout: implementConfig.timeout,
      preferredModels: implementConfig.preferredModels,
      preferredTools: implementConfig.preferredTools,
      prompt: implementConfig.prompt,
      modelDiversityGraceMs: implementConfig.modelDiversityGraceMs,
    };

    const implementBase: Omit<ReviewTask, 'id' | 'prompt' | 'task_type' | 'feature' | 'group_id'> =
      {
        ...baseTask,
        review_count: implementConfig.agentCount,
        timeout_at: Date.now() + implementTimeoutMs,
        config: implementTaskConfig,
      };

    const groupId = await createTaskGroup(
      store,
      'implement',
      implementConfig,
      implementBase,
      logger,
      {
        issue_number: issueDetails.number,
        issue_url: issueDetails.html_url,
        issue_title: issueDetails.title,
        issue_body: issueDetails.body ?? undefined,
        issue_author: issueDetails.user.login,
      },
      created,
    );
    if (groupId !== null) created = true;
  }

  // Triage label trigger
  if (
    fullConfig.triage?.enabled &&
    isLabelTriggerEnabled(fullConfig.triage.trigger) &&
    fullConfig.triage.trigger.label === addedLabel
  ) {
    logger.info('Triage label trigger matched', {
      issueNumber: issue.number,
      label: addedLabel,
    });

    await createTaskGroup(
      store,
      'triage',
      fullConfig.triage,
      baseTask,
      logger,
      issueFields,
      created,
    );
  }

  return new Response('OK', { status: 200 });
}

// ── Status Trigger Handler ──────────────────────────────────────

/**
 * Handle `projects_v2_item` webhook for status-based triggers.
 * When a project item's Status field changes to a configured value,
 * creates the appropriate task group.
 */
async function handleProjectsV2Item(
  github: GitHubService,
  store: DataStore,
  payload: ProjectsV2ItemPayload,
  logger: Logger,
): Promise<Response> {
  const { installation, projects_v2_item, changes } = payload;

  if (!installation) {
    logger.info('Projects V2 item event without installation — skipping');
    return new Response('OK', { status: 200 });
  }

  const fieldChange = changes?.field_value;
  if (!fieldChange || fieldChange.field_name !== 'Status') {
    logger.info('Projects V2 item event — not a Status field change, skipping');
    return new Response('OK', { status: 200 });
  }

  const newStatus = fieldChange.to;
  if (!newStatus) {
    logger.info('Projects V2 item event — no new status value, skipping');
    return new Response('OK', { status: 200 });
  }

  logger.info('Projects V2 item status changed', {
    contentNodeId: projects_v2_item.content_node_id,
    from: fieldChange.from,
    to: newStatus,
  });

  let token: string;
  try {
    token = await github.getInstallationToken(installation.id);
  } catch (err) {
    logger.error('Failed to get installation token for status trigger', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response('Service Unavailable', { status: 503 });
  }

  // Resolve the project item to an issue or PR
  const content = await github.resolveProjectItemContent(projects_v2_item.content_node_id, token);

  if (!content) {
    logger.info('Could not resolve project item content — skipping', {
      contentNodeId: projects_v2_item.content_node_id,
    });
    return new Response('OK', { status: 200 });
  }

  const { type, owner, repo, number } = content;

  // Load config from the repo
  const defaultBranch = 'main'; // GraphQL doesn't give us default_branch, use 'main'
  const { config: fullConfig, parseError } = await github.loadOpenCaraConfig(
    owner,
    repo,
    defaultBranch,
    token,
  );

  if (parseError) {
    logger.info('Aborting status trigger due to .opencara.toml parse error', {
      owner,
      repo,
      number,
    });
    return new Response('Service Unavailable', { status: 503 });
  }

  // Implement status trigger (primary use case — issues only)
  if (
    type === 'Issue' &&
    fullConfig.implement?.enabled &&
    isStatusTriggerEnabled(fullConfig.implement.trigger) &&
    fullConfig.implement.trigger.status === newStatus
  ) {
    logger.info('Implement status trigger matched', {
      owner,
      repo,
      issueNumber: number,
      status: newStatus,
    });

    let issue: Awaited<ReturnType<GitHubService['fetchIssueDetails']>>;
    try {
      issue = await github.fetchIssueDetails(owner, repo, number, token);
    } catch (err) {
      logger.error('Failed to fetch issue details for status trigger', {
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response('Service Unavailable', { status: 503 });
    }
    if (!issue) {
      logger.error('Issue not found for status trigger', { owner, repo, number });
      return new Response('Service Unavailable', { status: 503 });
    }

    const reviewConfig = fullConfig.review ?? DEFAULT_REVIEW_CONFIG;
    const implementConfig = fullConfig.implement;
    const timeoutMs = parseTimeoutMs(implementConfig.timeout);

    const implementTaskConfig: ReviewConfig = {
      ...reviewConfig,
      agentCount: implementConfig.agentCount,
      timeout: implementConfig.timeout,
      preferredModels: implementConfig.preferredModels,
      preferredTools: implementConfig.preferredTools,
      prompt: implementConfig.prompt,
      modelDiversityGraceMs: implementConfig.modelDiversityGraceMs,
    };

    const baseTask: Omit<ReviewTask, 'id' | 'prompt' | 'task_type' | 'feature' | 'group_id'> = {
      owner,
      repo,
      pr_number: 0,
      pr_url: '',
      diff_url: '',
      base_ref: '',
      head_ref: '',
      review_count: implementConfig.agentCount,
      timeout_at: Date.now() + timeoutMs,
      status: 'pending',
      queue: 'summary',
      github_installation_id: installation.id,
      private: false,
      config: implementTaskConfig,
      created_at: Date.now(),
    };

    try {
      await createTaskGroup(store, 'implement', implementConfig, baseTask, logger, {
        issue_number: issue.number,
        issue_url: issue.html_url,
        issue_title: issue.title,
        issue_body: issue.body ?? undefined,
        issue_author: issue.user.login,
      });
    } catch (err) {
      logger.error('Failed to create implement task group from status trigger', {
        error: err instanceof Error ? err.message : String(err),
        owner,
        repo,
        issueNumber: number,
      });
      return new Response('Service Unavailable', { status: 503 });
    }
  }

  return new Response('OK', { status: 200 });
}
