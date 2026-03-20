import { describe, it, expect } from 'vitest';
import { DEFAULT_REVIEW_CONFIG } from '@opencara/shared';
import { shouldSkipReview, parseTimeoutMs, isRepoAllowed } from '../eligibility.js';

describe('shouldSkipReview', () => {
  it('returns null when no skip conditions match', () => {
    expect(shouldSkipReview(DEFAULT_REVIEW_CONFIG, { headRef: 'feature' })).toBeNull();
  });

  it('skips draft PRs when configured', () => {
    expect(shouldSkipReview(DEFAULT_REVIEW_CONFIG, { draft: true, headRef: 'feature' })).toContain(
      'draft',
    );
  });

  it('skips PRs with matching label', () => {
    const config = {
      ...DEFAULT_REVIEW_CONFIG,
      trigger: { ...DEFAULT_REVIEW_CONFIG.trigger, skip: ['label:no-review'] },
    };
    expect(
      shouldSkipReview(config, {
        labels: [{ name: 'no-review' }],
        headRef: 'feature',
      }),
    ).toContain('label');
  });

  it('skips PRs with matching branch pattern', () => {
    const config = {
      ...DEFAULT_REVIEW_CONFIG,
      trigger: { ...DEFAULT_REVIEW_CONFIG.trigger, skip: ['branch:dependabot/*'] },
    };
    expect(shouldSkipReview(config, { headRef: 'dependabot/npm/lodash' })).toContain('Branch');
  });

  it('does not skip when branch does not match', () => {
    const config = {
      ...DEFAULT_REVIEW_CONFIG,
      trigger: { ...DEFAULT_REVIEW_CONFIG.trigger, skip: ['branch:release/*'] },
    };
    expect(shouldSkipReview(config, { headRef: 'feature/new-thing' })).toBeNull();
  });
});

describe('parseTimeoutMs', () => {
  it('parses valid timeout', () => {
    expect(parseTimeoutMs('5m')).toBe(5 * 60 * 1000);
  });

  it('defaults to 10m for invalid', () => {
    expect(parseTimeoutMs('invalid')).toBe(10 * 60 * 1000);
  });

  it('defaults to 10m for empty', () => {
    expect(parseTimeoutMs('')).toBe(10 * 60 * 1000);
  });
});

describe('isRepoAllowed', () => {
  it('allows all when config is null', () => {
    expect(isRepoAllowed(null, 'org', 'repo')).toBe(true);
  });

  it('allows all when mode is all', () => {
    expect(isRepoAllowed({ mode: 'all' }, 'org', 'repo')).toBe(true);
  });

  it('allows own repos only', () => {
    expect(isRepoAllowed({ mode: 'own' }, 'alice', 'repo', 'alice')).toBe(true);
    expect(isRepoAllowed({ mode: 'own' }, 'bob', 'repo', 'alice')).toBe(false);
  });

  it('whitelist mode', () => {
    const config = { mode: 'whitelist' as const, list: ['org/repo-a'] };
    expect(isRepoAllowed(config, 'org', 'repo-a')).toBe(true);
    expect(isRepoAllowed(config, 'org', 'repo-b')).toBe(false);
  });

  it('blacklist mode', () => {
    const config = { mode: 'blacklist' as const, list: ['org/private'] };
    expect(isRepoAllowed(config, 'org', 'public')).toBe(true);
    expect(isRepoAllowed(config, 'org', 'private')).toBe(false);
  });
});
