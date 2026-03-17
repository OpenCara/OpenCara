import { parseReviewConfig, DEFAULT_REVIEW_CONFIG, type ReviewConfig } from '@opencrust/shared';
import { createSupabaseClient } from './db.js';
import type { Env } from './env.js';
import { fetchPrDiff, fetchReviewConfig, getInstallationToken, postPrComment } from './github.js';
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
  };
}

interface InstallationPayload {
  action: string;
  installation: { id: number; account: { login: string } };
  repositories?: Array<{ name: string; full_name: string }>;
}

async function handlePullRequest(payload: PullRequestPayload, env: Env): Promise<Response> {
  const { installation, repository, pull_request } = payload;

  if (!installation) {
    console.log('PR event without installation — skipping');
    return new Response('OK', { status: 200 });
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const prNumber = pull_request.number;
  const headRef = pull_request.head.ref;

  console.log(`Processing PR #${prNumber} on ${owner}/${repo} (head: ${headRef})`);

  let token: string;
  try {
    token = await getInstallationToken(installation.id, env);
  } catch (err) {
    console.error('Failed to get installation token:', err);
    return new Response('OK', { status: 200 });
  }

  let configYaml: string | null;
  try {
    configYaml = await fetchReviewConfig(owner, repo, headRef, token);
  } catch (err) {
    console.error('Failed to fetch .review.yml:', err);
    return new Response('OK', { status: 200 });
  }

  let config: ReviewConfig;

  if (configYaml === null) {
    console.log(`No .review.yml found in ${owner}/${repo} — using default review config`);
    config = DEFAULT_REVIEW_CONFIG;
  } else {
    const parsed = parseReviewConfig(configYaml);

    if ('error' in parsed) {
      console.log(`.review.yml parse error: ${parsed.error}`);
      try {
        await postPrComment(
          owner,
          repo,
          prNumber,
          `**OpenCrust**: Failed to parse \`.review.yml\`: ${parsed.error}`,
          token,
        );
      } catch (err) {
        console.error('Failed to post error comment:', err);
      }
      return new Response('OK', { status: 200 });
    }
    config = parsed;
  }

  console.log(`Review config for ${owner}/${repo}:`, {
    version: config.version,
    agentMinCount: config.agents.minCount,
    timeout: config.timeout,
    hasCustomConfig: configYaml !== null,
    prUrl: pull_request.html_url,
    diffUrl: pull_request.diff_url,
    baseRef: pull_request.base.ref,
    headRef,
  });

  // Fetch the PR diff content
  let diffContent: string;
  try {
    diffContent = await fetchPrDiff(owner, repo, prNumber, token);
  } catch (err) {
    console.error('Failed to fetch PR diff:', err);
    return new Response('OK', { status: 200 });
  }

  // Create review task and distribute to eligible agents
  const supabase = createSupabaseClient(env);
  try {
    const taskId = await distributeTask(env, supabase, {
      installationId: installation.id,
      owner,
      repo,
      prNumber,
      prUrl: pull_request.html_url,
      diffUrl: pull_request.diff_url,
      baseRef: pull_request.base.ref,
      headRef,
      config,
      diffContent,
    });
    console.log(`Task distributed: ${taskId ?? 'failed'} for PR #${prNumber}`);
  } catch (err) {
    console.error('Failed to distribute task:', err);
  }

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
      if (action === 'opened' || action === 'synchronize') {
        return handlePullRequest(payload as unknown as PullRequestPayload, env);
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
