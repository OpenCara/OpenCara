import type { Env } from '../types.js';
import type { Logger } from '../logger.js';
import { createLogger } from '../logger.js';
import { getInstallationToken } from './app.js';
import { githubFetch } from './fetch.js';
import { postPrComment } from './reviews.js';
import {
  fetchPrDetails,
  loadReviewConfig as loadReviewConfigImpl,
  loadOpenCaraConfig as loadOpenCaraConfigImpl,
  type PrDetails,
} from './config.js';
import type { ReviewConfig, OpenCaraConfig } from '@opencara/shared';
import { DEFAULT_REVIEW_CONFIG, DEFAULT_OPENCARA_CONFIG } from '@opencara/shared';

export type { PrDetails } from './config.js';

/** Minimal issue details fetched from GitHub API */
export interface IssueDetails {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  user: { login: string };
}

/**
 * GitHubService — abstraction over all GitHub API interactions.
 *
 * Implementations:
 *   - RealGitHubService: production, real GitHub API calls
 *   - NoOpGitHubService: dev mode, logs and skips
 */
export interface GitHubService {
  getInstallationToken(installationId: number): Promise<string>;
  postPrComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    token: string,
  ): Promise<string>;
  fetchPrDetails(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
  ): Promise<PrDetails | null>;
  loadReviewConfig(
    owner: string,
    repo: string,
    baseRef: string,
    prNumber: number,
    token: string,
  ): Promise<{ config: ReviewConfig; parseError: boolean }>;
  loadOpenCaraConfig(
    owner: string,
    repo: string,
    ref: string,
    token: string,
  ): Promise<{ config: OpenCaraConfig; parseError: boolean }>;

  // PR review comments (for fix tasks)
  fetchPrReviewComments(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
  ): Promise<string>;

  // Issue management
  updateIssue(
    owner: string,
    repo: string,
    number: number,
    updates: { title?: string; body?: string; labels?: string[] },
    token: string,
  ): Promise<void>;
  fetchIssueBody(
    owner: string,
    repo: string,
    number: number,
    token: string,
  ): Promise<string | null>;
  fetchIssueDetails(
    owner: string,
    repo: string,
    number: number,
    token: string,
  ): Promise<IssueDetails | null>;
  createIssue(
    owner: string,
    repo: string,
    fields: { title: string; body: string; labels?: string[] },
    token: string,
  ): Promise<number>;

  // Comment management
  listIssueComments(
    owner: string,
    repo: string,
    number: number,
    token: string,
  ): Promise<Array<{ id: number; body: string }>>;
  createIssueComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
    token: string,
  ): Promise<number>;
  updateIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string,
    token: string,
  ): Promise<void>;
}

/**
 * Production implementation — delegates to real GitHub API functions.
 */
export class RealGitHubService implements GitHubService {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly logger: Logger;

  constructor(appId: string, privateKey: string, logger?: Logger) {
    this.appId = appId;
    this.privateKey = privateKey;
    this.logger = logger ?? createLogger();
  }

  async getInstallationToken(installationId: number): Promise<string> {
    const env = {
      GITHUB_APP_ID: this.appId,
      GITHUB_APP_PRIVATE_KEY: this.privateKey,
    } as Env;
    return getInstallationToken(installationId, env);
  }

  async postPrComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    token: string,
  ): Promise<string> {
    return postPrComment(owner, repo, prNumber, body, token);
  }

  async fetchPrDetails(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
  ): Promise<PrDetails | null> {
    return fetchPrDetails(owner, repo, prNumber, token, this.logger);
  }

  async loadReviewConfig(
    owner: string,
    repo: string,
    baseRef: string,
    prNumber: number,
    token: string,
  ): Promise<{ config: ReviewConfig; parseError: boolean }> {
    return loadReviewConfigImpl(owner, repo, baseRef, prNumber, token, this.logger);
  }

  async loadOpenCaraConfig(
    owner: string,
    repo: string,
    ref: string,
    token: string,
  ): Promise<{ config: OpenCaraConfig; parseError: boolean }> {
    // Note: prNumber=0 is a dummy — loadOpenCaraConfig doesn't post PR comments for issue events
    return loadOpenCaraConfigImpl(owner, repo, ref, 0, token, this.logger);
  }

  async fetchPrReviewComments(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
  ): Promise<string> {
    const lines: string[] = [];

    // Fetch inline review comments (line-level)
    const commentsRes = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`,
      { token },
    );
    if (commentsRes.ok) {
      const comments = (await commentsRes.json()) as Array<{
        user: { login: string };
        path: string;
        line?: number | null;
        original_line?: number | null;
        body: string;
      }>;
      for (const c of comments) {
        const line = c.line ?? c.original_line ?? null;
        const loc = line ? `${c.path}:${line}` : c.path;
        lines.push(`[${c.user.login}] ${loc}\n${c.body}`);
      }
    } else {
      this.logger.warn('Failed to fetch PR inline comments', {
        status: commentsRes.status,
        owner,
        repo,
        prNumber,
      });
    }

    // Fetch general review bodies
    const reviewsRes = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`,
      { token },
    );
    if (reviewsRes.ok) {
      const reviews = (await reviewsRes.json()) as Array<{
        user: { login: string };
        state: string;
        body: string | null;
      }>;
      for (const r of reviews) {
        if (r.body && r.body.trim().length > 0) {
          lines.push(`[${r.user.login}] (${r.state})\n${r.body}`);
        }
      }
    } else {
      this.logger.warn('Failed to fetch PR reviews', {
        status: reviewsRes.status,
        owner,
        repo,
        prNumber,
      });
    }

    return lines.join('\n\n---\n\n');
  }

  async updateIssue(
    owner: string,
    repo: string,
    number: number,
    updates: { title?: string; body?: string; labels?: string[] },
    token: string,
  ): Promise<void> {
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${number}`,
      {
        method: 'PATCH',
        token,
        body: JSON.stringify(updates),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to update issue #${number}: ${response.status} ${response.statusText}`,
      );
    }
  }

  async fetchIssueBody(
    owner: string,
    repo: string,
    number: number,
    token: string,
  ): Promise<string | null> {
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${number}`,
      { token },
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `Failed to fetch issue #${number}: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { body: string | null };
    return data.body ?? null;
  }

  async fetchIssueDetails(
    owner: string,
    repo: string,
    number: number,
    token: string,
  ): Promise<IssueDetails | null> {
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${number}`,
      { token },
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `Failed to fetch issue #${number}: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as IssueDetails;
    return data;
  }

  async createIssue(
    owner: string,
    repo: string,
    fields: { title: string; body: string; labels?: string[] },
    token: string,
  ): Promise<number> {
    const response = await githubFetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      token,
      body: JSON.stringify(fields),
    });

    if (!response.ok) {
      throw new Error(`Failed to create issue: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { number: number };
    return data.number;
  }

  async listIssueComments(
    owner: string,
    repo: string,
    number: number,
    token: string,
  ): Promise<Array<{ id: number; body: string }>> {
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
      { token },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to list comments for issue #${number}: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as Array<{ id: number; body: string | null }>;
    return data.map((c) => ({ id: c.id, body: c.body ?? '' }));
  }

  async createIssueComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
    token: string,
  ): Promise<number> {
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
      {
        method: 'POST',
        token,
        body: JSON.stringify({ body }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to create comment on issue #${number}: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { id: number };
    return data.id;
  }

  async updateIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string,
    token: string,
  ): Promise<void> {
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`,
      {
        method: 'PATCH',
        token,
        body: JSON.stringify({ body }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to update comment ${commentId}: ${response.status} ${response.statusText}`,
      );
    }
  }
}

/**
 * Dev/test implementation — logs and skips all GitHub interaction.
 * Returns sensible defaults so the task lifecycle works end-to-end
 * without real GitHub credentials.
 */
export class NoOpGitHubService implements GitHubService {
  private readonly logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger();
  }

  async getInstallationToken(installationId: number): Promise<string> {
    this.logger.info('Dev mode — skipping GitHub token exchange', { installationId });
    return 'dev-token';
  }

  async postPrComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<string> {
    this.logger.info('Dev mode — skipping GitHub PR comment', {
      owner,
      repo,
      prNumber,
      bodyLength: body.length,
    });
    return 'https://dev-mode/no-comment';
  }

  async fetchPrDetails(owner: string, repo: string, prNumber: number): Promise<PrDetails | null> {
    this.logger.info('Dev mode — returning mock PR details', { owner, repo, prNumber });
    return {
      number: prNumber,
      html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      diff_url: `https://github.com/${owner}/${repo}/pull/${prNumber}.diff`,
      base: { ref: 'main' },
      head: { ref: 'dev', sha: 'abc123' },
      user: { login: 'dev-user' },
      draft: false,
      labels: [],
      additions: 10,
      deletions: 5,
    };
  }

  async loadReviewConfig(): Promise<{ config: ReviewConfig; parseError: boolean }> {
    this.logger.info('Dev mode — using default review config');
    return { config: DEFAULT_REVIEW_CONFIG, parseError: false };
  }

  async loadOpenCaraConfig(): Promise<{ config: OpenCaraConfig; parseError: boolean }> {
    this.logger.info('Dev mode — using default opencara config');
    return { config: DEFAULT_OPENCARA_CONFIG, parseError: false };
  }

  async fetchPrReviewComments(owner: string, repo: string, prNumber: number): Promise<string> {
    this.logger.info('Dev mode — returning mock PR review comments', { owner, repo, prNumber });
    return `[mock-reviewer] src/index.ts:10\nPlease fix this bug`;
  }

  async updateIssue(
    owner: string,
    repo: string,
    number: number,
    updates: { title?: string; body?: string; labels?: string[] },
  ): Promise<void> {
    this.logger.info('Dev mode — skipping issue update', {
      owner,
      repo,
      number,
      updates: Object.keys(updates),
    });
  }

  async fetchIssueBody(owner: string, repo: string, number: number): Promise<string | null> {
    this.logger.info('Dev mode — returning mock issue body', { owner, repo, number });
    return `Mock issue body for #${number}`;
  }

  async fetchIssueDetails(
    owner: string,
    repo: string,
    number: number,
  ): Promise<IssueDetails | null> {
    this.logger.info('Dev mode — returning mock issue details', { owner, repo, number });
    return {
      number,
      html_url: `https://github.com/${owner}/${repo}/issues/${number}`,
      title: `Mock issue #${number}`,
      body: `Mock issue body for #${number}`,
      user: { login: 'mock-user' },
    };
  }

  async createIssue(
    owner: string,
    repo: string,
    fields: { title: string; body: string; labels?: string[] },
  ): Promise<number> {
    this.logger.info('Dev mode — skipping issue creation', {
      owner,
      repo,
      title: fields.title,
    });
    return 0;
  }

  private commentIdCounter = 1000;
  private comments = new Map<string, Array<{ id: number; body: string }>>();

  async listIssueComments(
    owner: string,
    repo: string,
    number: number,
  ): Promise<Array<{ id: number; body: string }>> {
    this.logger.info('Dev mode — returning mock issue comments', { owner, repo, number });
    const key = `${owner}/${repo}#${number}`;
    return this.comments.get(key) ?? [];
  }

  async createIssueComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<number> {
    this.logger.info('Dev mode — creating mock issue comment', {
      owner,
      repo,
      number,
      bodyLength: body.length,
    });
    const key = `${owner}/${repo}#${number}`;
    const id = this.commentIdCounter++;
    const list = this.comments.get(key) ?? [];
    list.push({ id, body });
    this.comments.set(key, list);
    return id;
  }

  async updateIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string,
  ): Promise<void> {
    this.logger.info('Dev mode — updating mock issue comment', {
      owner,
      repo,
      commentId,
      bodyLength: body.length,
    });
    for (const [, list] of this.comments) {
      const comment = list.find((c) => c.id === commentId);
      if (comment) {
        comment.body = body;
        return;
      }
    }
  }
}
