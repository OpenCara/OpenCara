import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_REVIEW_CONFIG } from '@opencara/shared';
import {
  shouldSkipReview,
  parseTimeoutMs,
  isRepoAllowed,
  isAgentEligibleForRole,
} from '../eligibility.js';

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

  it('logs warning and does not skip for invalid glob pattern', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Force RegExp constructor to throw for the glob-derived pattern
    const OrigRegExp = globalThis.RegExp;
    globalThis.RegExp = class extends OrigRegExp {
      constructor(pattern: string, flags?: string) {
        if (typeof pattern === 'string' && pattern.startsWith('^')) {
          throw new SyntaxError('Invalid regular expression');
        }
        super(pattern, flags);
      }
    } as typeof RegExp;

    try {
      const config = {
        ...DEFAULT_REVIEW_CONFIG,
        trigger: { ...DEFAULT_REVIEW_CONFIG.trigger, skip: ['branch:test-*'] },
      };
      expect(shouldSkipReview(config, { headRef: 'test-branch' })).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid glob pattern in skip config'),
      );
    } finally {
      globalThis.RegExp = OrigRegExp;
      warnSpy.mockRestore();
    }
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

describe('isAgentEligibleForRole', () => {
  const baseConfig = DEFAULT_REVIEW_CONFIG;

  describe('empty whitelist and blacklist (default — open review)', () => {
    it('allows any agent for review', () => {
      const result = isAgentEligibleForRole(baseConfig, 'review', 'agent-xyz');
      expect(result.eligible).toBe(true);
    });

    it('allows any agent for summary', () => {
      const result = isAgentEligibleForRole(baseConfig, 'summary', 'agent-xyz');
      expect(result.eligible).toBe(true);
    });
  });

  describe('whitelist only', () => {
    const config = {
      ...baseConfig,
      reviewer: {
        ...baseConfig.reviewer,
        whitelist: [{ agent: 'agent-abc' }, { agent: 'agent-def' }],
      },
    };

    it('allows whitelisted agents', () => {
      expect(isAgentEligibleForRole(config, 'review', 'agent-abc').eligible).toBe(true);
      expect(isAgentEligibleForRole(config, 'review', 'agent-def').eligible).toBe(true);
    });

    it('blocks non-whitelisted agents', () => {
      const result = isAgentEligibleForRole(config, 'review', 'agent-unknown');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('not in the review whitelist');
    });
  });

  describe('blacklist only', () => {
    const config = {
      ...baseConfig,
      reviewer: {
        ...baseConfig.reviewer,
        blacklist: [{ agent: 'agent-spammy' }],
      },
    };

    it('blocks blacklisted agents', () => {
      const result = isAgentEligibleForRole(config, 'review', 'agent-spammy');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('blacklisted');
    });

    it('allows non-blacklisted agents', () => {
      expect(isAgentEligibleForRole(config, 'review', 'agent-good').eligible).toBe(true);
    });
  });

  describe('both whitelist and blacklist', () => {
    const config = {
      ...baseConfig,
      reviewer: {
        ...baseConfig.reviewer,
        whitelist: [{ agent: 'agent-abc' }, { agent: 'agent-bad' }],
        blacklist: [{ agent: 'agent-bad' }],
      },
    };

    it('blacklist takes priority over whitelist', () => {
      const result = isAgentEligibleForRole(config, 'review', 'agent-bad');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('blacklisted');
    });

    it('allows whitelisted agents not in blacklist', () => {
      expect(isAgentEligibleForRole(config, 'review', 'agent-abc').eligible).toBe(true);
    });

    it('blocks agents in neither list when whitelist is non-empty', () => {
      const result = isAgentEligibleForRole(config, 'review', 'agent-other');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('not in the review whitelist');
    });
  });

  describe('summarizer role', () => {
    const config = {
      ...baseConfig,
      summarizer: {
        whitelist: [{ agent: 'agent-synth' }],
        blacklist: [],
        preferred: [],
      },
    };

    it('allows whitelisted summarizer agents', () => {
      expect(isAgentEligibleForRole(config, 'summary', 'agent-synth').eligible).toBe(true);
    });

    it('blocks non-whitelisted summarizer agents', () => {
      const result = isAgentEligibleForRole(config, 'summary', 'agent-other');
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('not in the summary whitelist');
    });

    it('reviewer config does not affect summarizer', () => {
      const mixedConfig = {
        ...baseConfig,
        reviewer: {
          ...baseConfig.reviewer,
          blacklist: [{ agent: 'agent-synth' }],
        },
        summarizer: {
          whitelist: [{ agent: 'agent-synth' }],
          blacklist: [],
        },
      };
      expect(isAgentEligibleForRole(mixedConfig, 'summary', 'agent-synth').eligible).toBe(true);
      expect(isAgentEligibleForRole(mixedConfig, 'review', 'agent-synth').eligible).toBe(false);
    });
  });

  describe('whitelist with user-only entries', () => {
    const config = {
      ...baseConfig,
      reviewer: {
        ...baseConfig.reviewer,
        whitelist: [{ user: 'alice' }],
      },
    };

    it('blocks agents when whitelist has only user entries (no agent entries match)', () => {
      const result = isAgentEligibleForRole(config, 'review', 'agent-xyz');
      expect(result.eligible).toBe(false);
    });
  });
});
