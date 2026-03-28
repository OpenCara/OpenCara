import { Hono } from 'hono';
import type {
  ReviewConfig,
  OpenCaraConfig,
  FeatureConfig,
  Feature,
  TaskRole,
  ReviewTask,
} from '@opencara/shared';
import { DEFAULT_REVIEW_CONFIG } from '@opencara/shared';
import type { Env, AppVariables } from '../types.js';
import type { DataStore } from '../store/interface.js';
import type { GitHubService } from '../github/service.js';
import type { Logger } from '../logger.js';
import { shouldSkipReview, parseTimeoutMs } from '../eligibility.js';
import { rateLimitByIP } from '../middleware/rate-limit.js';
import { apiError } from '../errors.js';
import { moveToRecentlyClosed, ageOutToArchived } from '../dedup-index.js';

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR']);

/** Maximum allowed length for config.prompt (10,000 characters). */
export const MAX_PROMPT_LENGTH = 10_000;

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
    html_url: string;
    diff_url: string;
    base: { ref: string };
    head: { ref: string };
    draft?: boolean;
    labels?: Array<{ name: string }>;
  };
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

  // Triage task group
  if (fullConfig.triage?.enabled && fullConfig.triage.triggers.includes(action)) {
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

  // Handle PR close/merge — move dedup index entries
  if (action === 'closed') {
    await handlePrClose(github, owner, repo, prNumber, fullConfig, token, logger);
    return new Response('OK', { status: 200 });
  }

  if (!reviewConfig.trigger.on.includes(action)) {
    logger.info('Action not in trigger.on — skipping', {
      prNumber,
      action,
      triggerOn: reviewConfig.trigger.on,
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

  // Handle issue close — move dedup index entries
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
    return new Response('OK', { status: 200 });
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

  const reviewConfig = fullConfig.review ?? DEFAULT_REVIEW_CONFIG;

  // Check if any feature is enabled for issues
  const triageEnabled = fullConfig.triage?.enabled && fullConfig.triage.triggers.includes(action);
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

/**
 * Parse a fix command from a comment body.
 * Matches `/opencara fix [model]` or `@opencara fix [model]`.
 * Returns the optional target model, or null if not a fix command.
 */
export function parseFixCommand(body: string): { targetModel?: string } | null {
  const trimmed = body.trim();
  // Match /opencara fix or @opencara fix (case-insensitive), optional model after
  const match = trimmed.match(/^[/@]opencara\s+fix(?:\s+(\S+))?/i);
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

  if (!issue.pull_request) {
    return new Response('OK', { status: 200 });
  }

  if (!installation) {
    logger.info('Comment event without installation — skipping');
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

  // Check for review trigger command
  const triggerCommand = reviewConfig.trigger.comment;
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
  if (!TRUSTED_ASSOCIATIONS.has(comment.author_association)) {
    logger.info('Fix command ignored — not a trusted contributor', {
      user: comment.user.login,
      association: comment.author_association,
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

  logger.info('Fix command received', {
    user: comment.user.login,
    owner,
    repo,
    prNumber,
    targetModel: fixCmd.targetModel,
  });

  // Fetch PR review comments
  let prReviewComments = '';
  try {
    prReviewComments = await github.fetchPrReviewComments(owner, repo, prNumber, token);
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
  const baseTask = buildBaseTask(
    installationId,
    owner,
    repo,
    prNumber,
    pr.html_url,
    pr.diff_url,
    pr.base.ref,
    pr.head.ref,
    reviewConfig,
    isPrivate,
    timeoutMs,
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
