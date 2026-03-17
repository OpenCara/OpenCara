/**
 * Factory functions for building GitHub webhook payloads.
 */

export interface PullRequestPayload {
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

export interface IssueCommentPayload {
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

export interface InstallationPayload {
  action: string;
  installation: { id: number; account: { login: string } };
  repositories?: Array<{ name: string; full_name: string }>;
}

export function buildPullRequestPayload(
  overrides?: Partial<PullRequestPayload> & {
    pr?: Partial<PullRequestPayload['pull_request']>;
    repo?: Partial<PullRequestPayload['repository']>;
  },
): PullRequestPayload {
  return {
    action: overrides?.action ?? 'opened',
    installation: overrides?.installation ?? { id: 12345 },
    repository: {
      owner: { login: overrides?.repo?.owner?.login ?? 'test-owner' },
      name: overrides?.repo?.name ?? 'test-repo',
      ...overrides?.repository,
    },
    pull_request: {
      number: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/1',
      diff_url: 'https://github.com/test-owner/test-repo/pull/1.diff',
      base: { ref: 'main' },
      head: { ref: 'feature-branch' },
      ...overrides?.pr,
      ...overrides?.pull_request,
    },
  };
}

export function buildIssueCommentPayload(
  overrides?: Partial<IssueCommentPayload> & {
    commentBody?: string;
    authorAssociation?: string;
    isPR?: boolean;
  },
): IssueCommentPayload {
  return {
    action: overrides?.action ?? 'created',
    installation: overrides?.installation ?? { id: 12345 },
    repository: {
      owner: { login: 'test-owner' },
      name: 'test-repo',
      ...overrides?.repository,
    },
    issue: {
      number: 1,
      pull_request:
        overrides?.isPR === false
          ? undefined
          : overrides?.issue?.pull_request ?? { url: 'https://api.github.com/repos/test-owner/test-repo/pulls/1' },
      ...overrides?.issue,
    },
    comment: {
      body: overrides?.commentBody ?? '/opencara review',
      user: { login: 'testuser' },
      author_association: overrides?.authorAssociation ?? 'OWNER',
      ...overrides?.comment,
    },
  };
}

export function buildInstallationPayload(
  action: 'created' | 'deleted',
  overrides?: Partial<InstallationPayload>,
): InstallationPayload {
  return {
    action,
    installation: overrides?.installation ?? {
      id: 12345,
      account: { login: 'test-owner' },
    },
    repositories: overrides?.repositories ?? [
      { name: 'test-repo', full_name: 'test-owner/test-repo' },
    ],
  };
}
