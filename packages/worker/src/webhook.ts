import { parseReviewConfig, DEFAULT_REVIEW_CONFIG, type ReviewConfig } from '@opencara/shared';
import { createSupabaseClient } from './db.js';
import type { Env } from './env.js';
import {
  fetchPrDiff,
  fetchPrDetails,
  fetchReviewConfig,
  getInstallationToken,
  postPrComment,
} from './github.js';
import { distributeTask } from './task-distribution.js';

/**
 * Validate the GitHub webhook signature using HMAC-SHA256.
 */
export async function verifySignature(
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
  if (!received) {
    return false;
  }

  if (expected.length !== received.length) {
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected[i] ^ received[i];
  }
  return result === 0;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

interface PullRequestPayload {
  action: string;
  installation?: { id: number };
  repository: { owner: { login: string }; name: string };
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
  repository: { owner: { login: string }; name: string };
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

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR']);

interface InstallationPayload {
  action: string;
  installation: { id: number; account: { login: string } };
  repositories?: Array<{ name: string; full_name: string }>;
}

/**
 * Check if the PR should be skipped based on trigger.skip conditions.
 */
function shouldSkipReview(
  config: ReviewConfig,
  pr: { draft?: boolean; labels?: Array<{ name: string }>; headRef: string },
): string | null {
  for (const condition of config.trigger.skip) {
    if (condition === 'draft' && pr.draft) {
      return 'PR is a draft';
    }
    if (condition.startsWith('label:')) {
      const labelName = condition.slice(6);
      if (pr.labels?.some((l) => l.name === labelName)) {
        return `PR has label "${labelName}"`;
      }
    }
    if (condition.startsWith('branch:')) {
      const pattern = condition.slice(7);
      if (matchGlob(pattern, pr.headRef)) {
        return `Branch "${pr.headRef}" matches skip pattern "${pattern}"`;
      }
    }
  }
  return null;
}

/**
 * Simple glob matching: supports * as wildcard.
 * Escapes regex metacharacters to prevent crashes from malformed patterns.
 */
function matchGlob(pattern: string, text: string): boolean {
  try {
    // Escape all regex metacharacters except *, then replace * with .*
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$').test(text);
  } catch {
    return false;
  }
}

/**
 * Fetch .review.yml and parse config. Returns DEFAULT_REVIEW_CONFIG on error/missing.
 * Posts a PR comment if the YAML is malformed.
 */
async function loadReviewConfig(
  owner: string,
  repo: string,
  headRef: string,
  prNumber: number,
  token: string,
): Promise<{ config: ReviewConfig; parseError: boolean }> {
  let configYaml: string | null;
  try {
    configYaml = await fetchReviewConfig(owner, repo, headRef, token);
  } catch (err) {
    console.error('Failed to fetch .review.yml:', err);
    return { config: DEFAULT_REVIEW_CONFIG, parseError: false };
  }

  if (configYaml === null) {
    console.log(`No .review.yml found in ${owner}/${repo} — using default review config`);
    return { config: DEFAULT_REVIEW_CONFIG, parseError: false };
  }

  const parsed = parseReviewConfig(configYaml);
  if ('error' in parsed) {
    console.log(`.review.yml parse error: ${parsed.error}`);
    try {
      await postPrComment(
        owner,
        repo,
        prNumber,
        `**OpenCara**: Failed to parse \`.review.yml\`: ${parsed.error}`,
        token,
      );
    } catch (err) {
      console.error('Failed to post error comment:', err);
    }
    return { config: DEFAULT_REVIEW_CONFIG, parseError: true };
  }

  return { config: parsed, parseError: false };
}

/**
 * Fetch diff and distribute a review task for a PR.
 */
async function dispatchReview(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  _prUrl: string,
  diffUrl: string,
  baseRef: string,
  headRef: string,
  config: ReviewConfig,
  token: string,
  env: Env,
): Promise<string | null> {
  console.log(`Review config for ${owner}/${repo}:`, {
    version: config.version,
    reviewCount: config.agents.reviewCount,
    trigger: config.trigger,
    timeout: config.timeout,
  });

  let diffContent: string;
  try {
    diffContent = await fetchPrDiff(owner, repo, prNumber, token);
  } catch (err) {
    console.error('Failed to fetch PR diff:', err);
    return null;
  }

  const supabase = createSupabaseClient(env);
  try {
    const taskId = await distributeTask(env, supabase, {
      installationId,
      owner,
      repo,
      prNumber,
      diffUrl,
      baseRef,
      headRef,
      config,
      diffContent,
    });
    console.log(`Task distributed: ${taskId ?? 'failed'} for PR #${prNumber}`);
    return taskId;
  } catch (err) {
    console.error('Failed to distribute task:', err);
    return null;
  }
}

async function handlePullRequest(
  payload: PullRequestPayload,
  action: string,
  env: Env,
): Promise<Response> {
  const { installation, repository, pull_request } = payload;

  if (!installation) {
    console.log('PR event without installation — skipping');
    return new Response('OK', { status: 200 });
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const prNumber = pull_request.number;
  const headRef = pull_request.head.ref;

  console.log(`PR #${prNumber} on ${owner}/${repo}: action=${action}, head=${headRef}`);

  let token: string;
  try {
    token = await getInstallationToken(installation.id, env);
  } catch (err) {
    console.error('Failed to get installation token:', err);
    return new Response('OK', { status: 200 });
  }

  const { config, parseError } = await loadReviewConfig(owner, repo, headRef, prNumber, token);

  // Abort on parse errors — don't run reviews with wrong config
  if (parseError) {
    console.log(`PR #${prNumber}: aborting due to .review.yml parse error`);
    return new Response('OK', { status: 200 });
  }

  // Check if this action is in the trigger.on list
  if (!config.trigger.on.includes(action)) {
    console.log(
      `PR #${prNumber}: action "${action}" not in trigger.on [${config.trigger.on.join(', ')}] — skipping`,
    );
    return new Response('OK', { status: 200 });
  }

  // Check skip conditions
  const skipReason = shouldSkipReview(config, {
    draft: pull_request.draft,
    labels: pull_request.labels,
    headRef,
  });
  if (skipReason) {
    console.log(`PR #${prNumber}: skipped — ${skipReason}`);
    return new Response('OK', { status: 200 });
  }

  await dispatchReview(
    installation.id,
    owner,
    repo,
    prNumber,
    pull_request.html_url,
    pull_request.diff_url,
    pull_request.base.ref,
    headRef,
    config,
    token,
    env,
  );

  return new Response('OK', { status: 200 });
}

async function handleIssueComment(payload: IssueCommentPayload, env: Env): Promise<Response> {
  const { installation, repository, issue, comment } = payload;

  // Only handle comments on PRs
  if (!issue.pull_request) {
    return new Response('OK', { status: 200 });
  }

  if (!installation) {
    console.log('Comment event without installation — skipping');
    return new Response('OK', { status: 200 });
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const prNumber = issue.number;

  let token: string;
  try {
    token = await getInstallationToken(installation.id, env);
  } catch (err) {
    console.error('Failed to get installation token:', err);
    return new Response('OK', { status: 200 });
  }

  // Fetch PR details (issue_comment payload doesn't include them)
  const pr = await fetchPrDetails(owner, repo, prNumber, token);
  if (!pr) {
    console.error(`Failed to fetch PR #${prNumber} details`);
    return new Response('OK', { status: 200 });
  }

  const { config } = await loadReviewConfig(owner, repo, pr.head.ref, prNumber, token);

  // Check if comment matches the trigger command
  const triggerCommand = config.trigger.comment;
  if (!comment.body.trim().toLowerCase().startsWith(triggerCommand.toLowerCase())) {
    return new Response('OK', { status: 200 });
  }

  // Only trusted users can trigger reviews
  if (!TRUSTED_ASSOCIATIONS.has(comment.author_association)) {
    console.log(
      `${triggerCommand} ignored from @${comment.user.login} (${comment.author_association}) — not a trusted contributor`,
    );
    return new Response('OK', { status: 200 });
  }

  console.log(
    `${triggerCommand} triggered by @${comment.user.login} on PR #${prNumber} (${owner}/${repo})`,
  );

  // Dispatch the review (skip conditions don't apply to manual triggers)
  await dispatchReview(
    installation.id,
    owner,
    repo,
    prNumber,
    pr.html_url,
    pr.diff_url,
    pr.base.ref,
    pr.head.ref,
    config,
    token,
    env,
  );

  return new Response('OK', { status: 200 });
}

async function handleInstallationCreated(payload: InstallationPayload): Promise<Response> {
  const { installation, repositories } = payload;
  const owner = installation.account.login;

  console.log(`GitHub App installed by ${owner} (installation: ${installation.id})`);

  if (repositories) {
    for (const repo of repositories) {
      console.log(`  → Repository: ${repo.full_name}`);
      // TODO (M2): Upsert project record in Supabase
      // INSERT INTO projects (id, github_installation_id, owner, repo, created_at)
      // VALUES (gen_random_uuid(), $installation_id, $owner, $repo, NOW())
      // ON CONFLICT (github_installation_id) DO UPDATE SET owner = $owner, repo = $repo;
    }
  }

  return new Response('OK', { status: 200 });
}

async function handleInstallationDeleted(payload: InstallationPayload): Promise<Response> {
  const { installation } = payload;
  const owner = installation.account.login;

  console.log(`GitHub App uninstalled by ${owner} (installation: ${installation.id})`);

  // TODO (M2): Delete project records from Supabase
  // DELETE FROM projects WHERE github_installation_id = $installation_id;

  return new Response('OK', { status: 200 });
}

export async function handleGitHubWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const signature = request.headers.get('X-Hub-Signature-256');

  const valid = await verifySignature(body, signature, env.GITHUB_WEBHOOK_SECRET);
  if (!valid) {
    return new Response('Unauthorized', { status: 401 });
  }

  const event = request.headers.get('X-GitHub-Event');
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  const action = typeof payload.action === 'string' ? payload.action : '';

  switch (event) {
    case 'pull_request':
      // All PR actions passed through — trigger.on filtering happens inside handlePullRequest
      return handlePullRequest(payload as unknown as PullRequestPayload, action, env);
    case 'issue_comment':
      if (action === 'created') {
        return handleIssueComment(payload as unknown as IssueCommentPayload, env);
      }
      break;
    case 'installation':
      if (action === 'created') {
        return handleInstallationCreated(payload as unknown as InstallationPayload);
      } else if (action === 'deleted') {
        return handleInstallationDeleted(payload as unknown as InstallationPayload);
      }
      break;
  }

  // Return 200 for all valid webhooks (even unhandled events)
  return new Response('OK', { status: 200 });
}
