import {
  parseOpenCaraConfig,
  DEFAULT_REVIEW_CONFIG,
  DEFAULT_OPENCARA_CONFIG,
  type ReviewConfig,
  type OpenCaraConfig,
} from '@opencara/shared';
import { githubFetch } from './fetch.js';
import { postPrComment } from './reviews.js';
import { createLogger, type Logger } from '../logger.js';

/**
 * Fetch the .opencara.toml file from a repository at a specific ref.
 * Returns null if the file doesn't exist.
 */
export async function fetchOpenCaraConfig(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<string | null> {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/.opencara.toml?ref=${ref}`,
    {
      token,
      accept: 'application/vnd.github.raw+json',
    },
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch .opencara.toml: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

/** @deprecated Use fetchOpenCaraConfig instead */
export const fetchReviewConfig = fetchOpenCaraConfig;

export interface PrDetails {
  number: number;
  html_url: string;
  diff_url: string;
  base: { ref: string };
  head: { ref: string; sha: string };
  user: { login: string };
  draft: boolean;
  labels: Array<{ name: string }>;
  additions?: number;
  deletions?: number;
}

/**
 * Fetch PR details from the GitHub API.
 */
export async function fetchPrDetails(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  logger: Logger = createLogger(),
): Promise<PrDetails | null> {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    { token },
  );

  if (!response.ok) {
    logger.error('Failed to fetch PR details', {
      status: response.status,
      statusText: response.statusText,
    });
    return null;
  }

  return (await response.json()) as PrDetails;
}

/**
 * Fetch .opencara.toml and parse config. Returns DEFAULT_REVIEW_CONFIG on error/missing.
 * Posts a PR comment if the TOML is malformed.
 */
export async function loadReviewConfig(
  owner: string,
  repo: string,
  baseRef: string,
  prNumber: number,
  token: string,
  logger: Logger = createLogger(),
): Promise<{ config: ReviewConfig; parseError: boolean }> {
  let configToml: string | null;
  try {
    configToml = await fetchOpenCaraConfig(owner, repo, baseRef, token);
  } catch (err) {
    logger.error('Failed to fetch .opencara.toml', {
      owner,
      repo,
      error: err instanceof Error ? err.message : String(err),
    });
    return { config: DEFAULT_REVIEW_CONFIG, parseError: false };
  }

  if (configToml === null) {
    logger.info('No .opencara.toml found — using default review config', { owner, repo });
    return { config: DEFAULT_REVIEW_CONFIG, parseError: false };
  }

  const parsed = parseOpenCaraConfig(configToml);
  if ('error' in parsed) {
    logger.info('.opencara.toml parse error', { error: parsed.error });
    try {
      await postPrComment(
        owner,
        repo,
        prNumber,
        `**OpenCara**: Failed to parse \`.opencara.toml\`: ${parsed.error}`,
        token,
      );
    } catch (err) {
      logger.error('Failed to post error comment', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { config: DEFAULT_REVIEW_CONFIG, parseError: true };
  }

  // Extract review section, falling back to defaults
  if (!parsed.review) {
    logger.info('.opencara.toml has no [review] section — using default review config', {
      owner,
      repo,
    });
  }
  return { config: parsed.review ?? DEFAULT_REVIEW_CONFIG, parseError: false };
}

/**
 * Load the full OpenCaraConfig (all sections, not just review).
 * Returns DEFAULT_OPENCARA_CONFIG on error/missing.
 */
export async function loadOpenCaraConfig(
  owner: string,
  repo: string,
  baseRef: string,
  prNumber: number,
  token: string,
  logger: Logger = createLogger(),
): Promise<{ config: OpenCaraConfig; parseError: boolean }> {
  let configToml: string | null;
  try {
    configToml = await fetchOpenCaraConfig(owner, repo, baseRef, token);
  } catch (err) {
    logger.error('Failed to fetch .opencara.toml', {
      owner,
      repo,
      error: err instanceof Error ? err.message : String(err),
    });
    return { config: DEFAULT_OPENCARA_CONFIG, parseError: false };
  }

  if (configToml === null) {
    logger.info('No .opencara.toml found — using default config', { owner, repo });
    return { config: DEFAULT_OPENCARA_CONFIG, parseError: false };
  }

  const parsed = parseOpenCaraConfig(configToml);
  if ('error' in parsed) {
    logger.info('.opencara.toml parse error', { error: parsed.error });
    try {
      await postPrComment(
        owner,
        repo,
        prNumber,
        `**OpenCara**: Failed to parse \`.opencara.toml\`: ${parsed.error}`,
        token,
      );
    } catch (err) {
      logger.error('Failed to post error comment', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { config: DEFAULT_OPENCARA_CONFIG, parseError: true };
  }

  return { config: parsed, parseError: false };
}
