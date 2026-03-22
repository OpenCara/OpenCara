import { Hono } from 'hono';
import type { ReviewConfig } from '@opencara/shared';
import type { Env, AppVariables } from '../types.js';
import type { DataStore } from '../store/interface.js';
import type { Logger } from '../logger.js';
import { getInstallationToken } from '../github/app.js';
import { loadReviewConfig, fetchPrDetails } from '../github/config.js';
import { shouldSkipReview, parseTimeoutMs } from '../eligibility.js';
import { rateLimitByIP } from '../middleware/rate-limit.js';
import { apiError } from '../errors.js';

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR']);

interface PullRequestPayload {
  action: string;
  installation?: { id: number };
  repository: { owner: { login: string }; name: string; private?: boolean };
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
  repository: { owner: { login: string }; name: string; private?: boolean };
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

/**
 * Create a task in the store for a PR. No diff fetching, no agent selection —
 * agents will poll and fetch diffs themselves.
 *
 * Returns null if an active (pending/reviewing) task already exists for this PR
 * (idempotency guard against webhook redeliveries and rapid PR events).
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
  // Check for existing active task on this PR (dedup guard)
  const activeTasks = await store.listTasks({ status: ['pending', 'reviewing'] });
  const duplicate = activeTasks.find(
    (t) => t.owner === owner && t.repo === repo && t.pr_number === prNumber,
  );
  if (duplicate) {
    logger.info('Task already exists for PR — skipping', {
      taskId: duplicate.id,
      owner,
      repo,
      prNumber,
    });
    return null;
  }

  const taskId = crypto.randomUUID();
  const timeoutMs = parseTimeoutMs(config.timeout);

  await store.createTask({
    id: taskId,
    owner,
    repo,
    pr_number: prNumber,
    pr_url: prUrl,
    diff_url: diffUrl,
    base_ref: baseRef,
    head_ref: headRef,
    review_count: config.agents.reviewCount,
    prompt: config.prompt,
    timeout_at: Date.now() + timeoutMs,
    status: 'pending',
    github_installation_id: installationId,
    private: isPrivate,
    config,
    created_at: Date.now(),
  });

  logger.info('Task created', { taskId, owner, repo, prNumber });
  return taskId;
}

export function webhookRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  app.post('/webhook/github', rateLimitByIP({ maxRequests: 60, windowMs: 60_000 }), async (c) => {
    const store = c.get('store');
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
          c.env,
          store,
          payload as unknown as PullRequestPayload,
          action,
          logger,
        );
      case 'issue_comment':
        if (action === 'created') {
          return handleIssueComment(
            c.env,
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
  env: Env,
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
    token = await getInstallationToken(installation.id, env);
  } catch (err) {
    logger.error('Failed to get installation token', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response('OK', { status: 200 });
  }

  const baseRef = pull_request.base.ref;
  const { config, parseError } = await loadReviewConfig(
    owner,
    repo,
    baseRef,
    prNumber,
    token,
    logger,
  );

  if (parseError) {
    logger.info('Aborting due to .review.yml parse error', { prNumber });
    return new Response('OK', { status: 200 });
  }

  if (!config.trigger.on.includes(action)) {
    logger.info('Action not in trigger.on — skipping', {
      prNumber,
      action,
      triggerOn: config.trigger.on,
    });
    return new Response('OK', { status: 200 });
  }

  const skipReason = shouldSkipReview(config, {
    draft: pull_request.draft,
    labels: pull_request.labels,
    headRef,
  });
  if (skipReason) {
    logger.info('PR skipped', { prNumber, reason: skipReason });
    return new Response('OK', { status: 200 });
  }

  await createTaskForPR(
    store,
    installation.id,
    owner,
    repo,
    prNumber,
    pull_request.html_url,
    pull_request.diff_url,
    pull_request.base.ref,
    headRef,
    config,
    repository.private ?? false,
    logger,
  );

  return new Response('OK', { status: 200 });
}

async function handleIssueComment(
  env: Env,
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
    token = await getInstallationToken(installation.id, env);
  } catch (err) {
    logger.error('Failed to get installation token', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response('OK', { status: 200 });
  }

  const pr = await fetchPrDetails(owner, repo, prNumber, token, logger);
  if (!pr) {
    logger.error('Failed to fetch PR details', { owner, repo, prNumber });
    return new Response('OK', { status: 200 });
  }

  const { config } = await loadReviewConfig(owner, repo, pr.base.ref, prNumber, token);

  const triggerCommand = config.trigger.comment;
  if (!comment.body.trim().toLowerCase().startsWith(triggerCommand.toLowerCase())) {
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
    config,
    repository.private ?? false,
    logger,
  );

  return new Response('OK', { status: 200 });
}
