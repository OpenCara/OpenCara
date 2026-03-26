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
  createIssue(
    owner: string,
    repo: string,
    fields: { title: string; body: string; labels?: string[] },
    token: string,
  ): Promise<number>;
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
      head: { ref: 'dev' },
      draft: false,
      labels: [],
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
}
