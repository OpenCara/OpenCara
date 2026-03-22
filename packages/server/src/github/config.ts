import { parseReviewConfig, DEFAULT_REVIEW_CONFIG, type ReviewConfig } from '@opencara/shared';
import { githubFetch } from './fetch.js';
import { postPrComment } from './reviews.js';
import { createLogger } from '../logger.js';

/**
 * Fetch the .review.yml file from a repository at a specific ref.
 * Returns null if the file doesn't exist.
 */
export async function fetchReviewConfig(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<string | null> {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/.review.yml?ref=${ref}`,
    {
      token,
      accept: 'application/vnd.github.raw+json',
    },
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch .review.yml: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

export interface PrDetails {
  number: number;
  html_url: string;
  diff_url: string;
  base: { ref: string };
  head: { ref: string };
  draft: boolean;
  labels: Array<{ name: string }>;
}

/**
 * Fetch PR details from the GitHub API.
 */
export async function fetchPrDetails(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<PrDetails | null> {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    { token },
  );

  if (!response.ok) {
    createLogger().error('Failed to fetch PR details', {
      status: response.status,
      statusText: response.statusText,
    });
    return null;
  }

  return (await response.json()) as PrDetails;
}

/**
 * Fetch .review.yml and parse config. Returns DEFAULT_REVIEW_CONFIG on error/missing.
 * Posts a PR comment if the YAML is malformed.
 */
export async function loadReviewConfig(
  owner: string,
  repo: string,
  baseRef: string,
  prNumber: number,
  token: string,
): Promise<{ config: ReviewConfig; parseError: boolean }> {
  const logger = createLogger();
  let configYaml: string | null;
  try {
    configYaml = await fetchReviewConfig(owner, repo, baseRef, token);
  } catch (err) {
    logger.error('Failed to fetch .review.yml', {
      owner,
      repo,
      error: err instanceof Error ? err.message : String(err),
    });
    return { config: DEFAULT_REVIEW_CONFIG, parseError: false };
  }

  if (configYaml === null) {
    logger.info('No .review.yml found — using default review config', { owner, repo });
    return { config: DEFAULT_REVIEW_CONFIG, parseError: false };
  }

  const parsed = parseReviewConfig(configYaml);
  if ('error' in parsed) {
    logger.info('.review.yml parse error', { error: parsed.error });
    try {
      await postPrComment(
        owner,
        repo,
        prNumber,
        `**OpenCara**: Failed to parse \`.review.yml\`: ${parsed.error}`,
        token,
      );
    } catch (err) {
      logger.error('Failed to post error comment', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { config: DEFAULT_REVIEW_CONFIG, parseError: true };
  }

  return { config: parsed, parseError: false };
}
