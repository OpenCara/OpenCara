import { describe, it, expect, vi } from 'vitest';
import {
  parseReviewConfig,
  parseEntityList,
  isEntityMatch,
  validateReviewConfig,
  DEFAULT_REVIEW_CONFIG,
  type ReviewConfig,
} from '../review-config.js';

const VALID_FULL_CONFIG = `
version: 1
prompt: |
  Focus on code quality, security, and test coverage.
  This project uses TypeScript + React, following ESLint standards.
agents:
  review_count: 2
  preferred_models:
    - claude-opus-4-6
    - glm-5
  preferred_tools:
    - claude-code
    - codex
reviewer:
  whitelist:
    - agent: abc-123
  blacklist:
    - agent: agent-bad
  allow_anonymous: false
summarizer:
  whitelist:
    - agent: agent-synth
  blacklist:
    - agent: agent-spam
timeout: 15m
`;

const MINIMAL_CONFIG = `
version: 1
prompt: Review this code.
`;

describe('parseReviewConfig', () => {
  it('parses a full valid config', () => {
    const result = parseReviewConfig(VALID_FULL_CONFIG);
    expect('error' in result).toBe(false);
    const config = result as ReviewConfig;
    expect(config.version).toBe(1);
    expect(config.prompt).toContain('Focus on code quality');
    expect(config.agents.reviewCount).toBe(2);
    expect(config.agents.preferredModels).toEqual(['claude-opus-4-6', 'glm-5']);
    expect(config.agents.preferredTools).toEqual(['claude-code', 'codex']);
    expect(config.reviewer.whitelist).toEqual([{ agent: 'abc-123' }]);
    expect(config.reviewer.blacklist).toEqual([{ agent: 'agent-bad' }]);
    expect(config.summarizer.whitelist).toEqual([{ agent: 'agent-synth' }]);
    expect(config.summarizer.blacklist).toEqual([{ agent: 'agent-spam' }]);
    expect(config.timeout).toBe('15m');
  });

  it('parses a minimal config with defaults', () => {
    const result = parseReviewConfig(MINIMAL_CONFIG);
    expect('error' in result).toBe(false);
    const config = result as ReviewConfig;
    expect(config.version).toBe(1);
    expect(config.prompt).toBe('Review this code.');
    expect(config.agents.reviewCount).toBe(1);
    expect(config.agents.preferredTools).toEqual([]);
    expect(config.reviewer.whitelist).toEqual([]);
    expect(config.reviewer.blacklist).toEqual([]);
    expect(config.summarizer.whitelist).toEqual([]);
    expect(config.summarizer.blacklist).toEqual([]);
    expect(config.summarizer.preferred).toEqual([]);
    expect(config.timeout).toBe('10m');
  });

  it('returns error for invalid YAML syntax', () => {
    const result = parseReviewConfig('{ invalid yaml: [');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('Invalid YAML syntax');
  });

  it('returns error for non-object YAML', () => {
    const result = parseReviewConfig('just a string');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('Configuration must be a YAML object');
  });

  it('returns error when version is missing', () => {
    const result = parseReviewConfig('prompt: hello');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('Missing required field: version');
  });

  it('returns error when version is not a number', () => {
    const result = parseReviewConfig('version: "one"\nprompt: hello');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('Field "version" must be a number');
  });

  it('returns error when prompt is missing', () => {
    const result = parseReviewConfig('version: 1');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('Missing required field: prompt');
  });

  it('returns error when prompt is not a string', () => {
    const result = parseReviewConfig('version: 1\nprompt: 123');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('Field "prompt" must be a string');
  });

  it('clamps review_count to range 1-10', () => {
    const low = parseReviewConfig(
      'version: 1\nprompt: test\nagents:\n  review_count: 0',
    ) as ReviewConfig;
    expect(low.agents.reviewCount).toBe(1);

    const high = parseReviewConfig(
      'version: 1\nprompt: test\nagents:\n  review_count: 99',
    ) as ReviewConfig;
    expect(high.agents.reviewCount).toBe(10);
  });

  it('uses default timeout for invalid format', () => {
    const result = parseReviewConfig('version: 1\nprompt: test\ntimeout: 2h') as ReviewConfig;
    expect(result.timeout).toBe('10m');
  });

  it('uses default timeout for out-of-range minutes', () => {
    const result = parseReviewConfig('version: 1\nprompt: test\ntimeout: 60m') as ReviewConfig;
    expect(result.timeout).toBe('10m');
  });

  it('accepts valid timeout values', () => {
    const r1 = parseReviewConfig('version: 1\nprompt: test\ntimeout: 1m') as ReviewConfig;
    expect(r1.timeout).toBe('1m');

    const r30 = parseReviewConfig('version: 1\nprompt: test\ntimeout: 30m') as ReviewConfig;
    expect(r30.timeout).toBe('30m');
  });

  it('filters non-string values from preferred_tools', () => {
    const result = parseReviewConfig(
      'version: 1\nprompt: test\nagents:\n  preferred_tools:\n    - claude-code\n    - 123\n    - codex',
    ) as ReviewConfig;
    expect(result.agents.preferredTools).toEqual(['claude-code', 'codex']);
  });

  it('logs deprecation warning when allow_anonymous is present', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseReviewConfig(
      'version: 1\nprompt: test\nreviewer:\n  allow_anonymous: false',
    ) as ReviewConfig;
    expect('error' in result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Deprecated: "reviewer.allow_anonymous" is ignored'),
    );
    warnSpy.mockRestore();
  });

  it('does not log deprecation warning when allow_anonymous is absent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseReviewConfig(MINIMAL_CONFIG);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('allow_anonymous'));
    warnSpy.mockRestore();
  });

  it('does not include allowAnonymous in parsed config', () => {
    const result = parseReviewConfig(
      'version: 1\nprompt: test\nreviewer:\n  allow_anonymous: false',
    ) as ReviewConfig;
    expect('allowAnonymous' in result.reviewer).toBe(false);
  });
});

describe('DEFAULT_REVIEW_CONFIG', () => {
  it('is a valid ReviewConfig', () => {
    expect(validateReviewConfig(DEFAULT_REVIEW_CONFIG)).toBe(true);
  });

  it('has sensible defaults', () => {
    expect(DEFAULT_REVIEW_CONFIG.version).toBe(1);
    expect(DEFAULT_REVIEW_CONFIG.prompt).toBeTruthy();
    expect(DEFAULT_REVIEW_CONFIG.agents.reviewCount).toBe(1);
    expect(DEFAULT_REVIEW_CONFIG.timeout).toBe('10m');
    expect(DEFAULT_REVIEW_CONFIG.trigger.on).toEqual(['opened']);
    expect(DEFAULT_REVIEW_CONFIG.trigger.comment).toBe('/opencara review');
    expect(DEFAULT_REVIEW_CONFIG.trigger.skip).toEqual(['draft']);
  });
});

describe('trigger config parsing', () => {
  it('parses custom trigger config', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\ntrigger:\n  on: [opened, synchronize]\n  comment: "/review"\n  skip: [draft, "label:wip"]',
    );
    expect('error' in config).toBe(false);
    if (!('error' in config)) {
      expect(config.trigger.on).toEqual(['opened', 'synchronize']);
      expect(config.trigger.comment).toBe('/review');
      expect(config.trigger.skip).toEqual(['draft', 'label:wip']);
    }
  });

  it('uses defaults when trigger section is missing', () => {
    const config = parseReviewConfig('version: 1\nprompt: test');
    expect('error' in config).toBe(false);
    if (!('error' in config)) {
      expect(config.trigger.on).toEqual(['opened']);
      expect(config.trigger.comment).toBe('/opencara review');
      expect(config.trigger.skip).toEqual(['draft']);
    }
  });

  it('uses defaults for individual missing trigger fields', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\ntrigger:\n  on: [ready_for_review]',
    );
    expect('error' in config).toBe(false);
    if (!('error' in config)) {
      expect(config.trigger.on).toEqual(['ready_for_review']);
      expect(config.trigger.comment).toBe('/opencara review');
      expect(config.trigger.skip).toEqual(['draft']);
    }
  });
});

describe('summarizer.preferred parsing', () => {
  it('parses preferred agent list', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nsummarizer:\n  preferred:\n    - agent: agent-abc\n    - agent: agent-def',
    ) as ReviewConfig;
    expect(config.summarizer.preferred).toEqual([{ agent: 'agent-abc' }, { agent: 'agent-def' }]);
  });

  it('defaults to empty array when preferred is not set', () => {
    const config = parseReviewConfig(MINIMAL_CONFIG) as ReviewConfig;
    expect(config.summarizer.preferred).toEqual([]);
  });

  it('filters out entries without agent or github field', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nsummarizer:\n  preferred:\n    - agent: agent-abc\n    - notanagent: true',
    ) as ReviewConfig;
    expect(config.summarizer.preferred).toEqual([{ agent: 'agent-abc' }]);
  });

  it('filters out non-object entries', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nsummarizer:\n  preferred:\n    - agent: agent-abc\n    - just-a-string\n    - 123',
    ) as ReviewConfig;
    expect(config.summarizer.preferred).toEqual([{ agent: 'agent-abc' }]);
  });

  it('returns empty array when preferred is not an array', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nsummarizer:\n  preferred: not-an-array',
    ) as ReviewConfig;
    expect(config.summarizer.preferred).toEqual([]);
  });

  it('parses full config with preferred alongside whitelist/blacklist', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nsummarizer:\n  whitelist:\n    - agent: agent-a\n  blacklist:\n    - agent: agent-b\n  preferred:\n    - agent: agent-a',
    ) as ReviewConfig;
    expect(config.summarizer.whitelist).toEqual([{ agent: 'agent-a' }]);
    expect(config.summarizer.blacklist).toEqual([{ agent: 'agent-b' }]);
    expect(config.summarizer.preferred).toEqual([{ agent: 'agent-a' }]);
  });
});

describe('user entries in whitelist/blacklist', () => {
  it('ignores user-only entries and logs a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nreviewer:\n  whitelist:\n    - user: alice\n    - agent: agent-abc',
    ) as ReviewConfig;
    expect(config.reviewer.whitelist).toEqual([{ agent: 'agent-abc' }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring "user" entry'));
    warnSpy.mockRestore();
  });

  it('keeps entries that have both user and agent fields (agent wins)', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nreviewer:\n  whitelist:\n    - user: alice\n      agent: agent-abc',
    ) as ReviewConfig;
    expect(config.reviewer.whitelist).toEqual([{ agent: 'agent-abc' }]);
  });

  it('produces empty list when all entries are user-only', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nreviewer:\n  blacklist:\n    - user: bob\n    - user: charlie',
    ) as ReviewConfig;
    expect(config.reviewer.blacklist).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});

describe('validateReviewConfig', () => {
  it('returns true for valid config', () => {
    const config = parseReviewConfig(VALID_FULL_CONFIG);
    expect('error' in config).toBe(false);
    expect(validateReviewConfig(config)).toBe(true);
  });

  it('returns false for null', () => {
    expect(validateReviewConfig(null)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(validateReviewConfig('hello')).toBe(false);
  });

  it('returns false for object missing version', () => {
    expect(validateReviewConfig({ prompt: 'test' })).toBe(false);
  });

  it('returns false for object missing prompt', () => {
    expect(validateReviewConfig({ version: 1 })).toBe(false);
  });

  it('returns false for object with wrong types', () => {
    expect(validateReviewConfig({ version: 'one', prompt: 'test' })).toBe(false);
  });
});

// ── New tests for #326 ─────────────────────────────────────────

describe('GitHub entity entries in entity lists', () => {
  it('parses github entries in whitelist', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nreviewer:\n  whitelist:\n    - github: alice\n    - agent: agent-abc',
    ) as ReviewConfig;
    expect(config.reviewer.whitelist).toEqual([{ github: 'alice' }, { agent: 'agent-abc' }]);
  });

  it('parses github entries in blacklist', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nsummarizer:\n  blacklist:\n    - github: mallory',
    ) as ReviewConfig;
    expect(config.summarizer.blacklist).toEqual([{ github: 'mallory' }]);
  });

  it('parses entries with both agent and github', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nsummarizer:\n  preferred:\n    - agent: agent-a\n      github: alice',
    ) as ReviewConfig;
    expect(config.summarizer.preferred).toEqual([{ agent: 'agent-a', github: 'alice' }]);
  });

  it('parses github entries in summarizer preferred list', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nsummarizer:\n  preferred:\n    - github: alice\n    - github: bob',
    ) as ReviewConfig;
    expect(config.summarizer.preferred).toEqual([{ github: 'alice' }, { github: 'bob' }]);
  });
});

describe('parseEntityList', () => {
  it('returns empty array for non-array input', () => {
    expect(parseEntityList('not-an-array')).toEqual([]);
    expect(parseEntityList(null)).toEqual([]);
    expect(parseEntityList(undefined)).toEqual([]);
  });

  it('skips non-object items', () => {
    expect(parseEntityList(['string', 123, true])).toEqual([]);
  });

  it('parses agent entries', () => {
    expect(parseEntityList([{ agent: 'a1' }])).toEqual([{ agent: 'a1' }]);
  });

  it('parses github entries', () => {
    expect(parseEntityList([{ github: 'alice' }])).toEqual([{ github: 'alice' }]);
  });

  it('parses mixed entries', () => {
    expect(parseEntityList([{ agent: 'a1' }, { github: 'alice' }])).toEqual([
      { agent: 'a1' },
      { github: 'alice' },
    ]);
  });

  it('skips entries without agent or github', () => {
    expect(parseEntityList([{ unknown: 'value' }])).toEqual([]);
  });

  it('warns on user-only entries', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseEntityList([{ user: 'bob' }])).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring "user" entry'));
    warnSpy.mockRestore();
  });

  it('does not warn on user entry when github is also present', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseEntityList([{ user: 'bob', github: 'bob' }])).toEqual([{ github: 'bob' }]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('summarizer shorthand parsing', () => {
  it('parses string shorthand as preferred github username', () => {
    const config = parseReviewConfig('version: 1\nprompt: test\nsummarizer: alice') as ReviewConfig;
    expect(config.summarizer.preferred).toEqual([{ github: 'alice' }]);
    expect(config.summarizer.whitelist).toEqual([]);
    expect(config.summarizer.blacklist).toEqual([]);
  });

  it('parses "only" string as whitelist with single github entry', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nsummarizer:\n  only: alice',
    ) as ReviewConfig;
    expect(config.summarizer.whitelist).toEqual([{ github: 'alice' }]);
    expect(config.summarizer.preferred).toEqual([]);
    expect(config.summarizer.blacklist).toEqual([]);
  });

  it('parses "only" list as whitelist with multiple github entries', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nsummarizer:\n  only: [alice, bob]',
    ) as ReviewConfig;
    expect(config.summarizer.whitelist).toEqual([{ github: 'alice' }, { github: 'bob' }]);
    expect(config.summarizer.preferred).toEqual([]);
    expect(config.summarizer.blacklist).toEqual([]);
  });

  it('parses full object form (backward compatible)', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nsummarizer:\n  whitelist:\n    - agent: agent-a\n  blacklist:\n    - github: mallory\n  preferred:\n    - github: alice',
    ) as ReviewConfig;
    expect(config.summarizer.whitelist).toEqual([{ agent: 'agent-a' }]);
    expect(config.summarizer.blacklist).toEqual([{ github: 'mallory' }]);
    expect(config.summarizer.preferred).toEqual([{ github: 'alice' }]);
  });

  it('returns defaults when summarizer is not present', () => {
    const config = parseReviewConfig(MINIMAL_CONFIG) as ReviewConfig;
    expect(config.summarizer.whitelist).toEqual([]);
    expect(config.summarizer.blacklist).toEqual([]);
    expect(config.summarizer.preferred).toEqual([]);
  });

  it('returns defaults when "only" has invalid value', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nsummarizer:\n  only: 123',
    ) as ReviewConfig;
    expect(config.summarizer.whitelist).toEqual([]);
    expect(config.summarizer.preferred).toEqual([]);
  });

  it('filters non-string entries in "only" list', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nsummarizer:\n  only:\n    - alice\n    - 123\n    - bob',
    ) as ReviewConfig;
    expect(config.summarizer.whitelist).toEqual([{ github: 'alice' }, { github: 'bob' }]);
  });
});

describe('isEntityMatch', () => {
  it('matches by agent ID', () => {
    expect(isEntityMatch({ agent: 'agent-abc' }, 'agent-abc')).toBe(true);
  });

  it('does not match different agent ID', () => {
    expect(isEntityMatch({ agent: 'agent-abc' }, 'agent-xyz')).toBe(false);
  });

  it('matches by github username', () => {
    expect(isEntityMatch({ github: 'alice' }, undefined, 'alice')).toBe(true);
  });

  it('matches github username case-insensitively', () => {
    expect(isEntityMatch({ github: 'Alice' }, undefined, 'alice')).toBe(true);
    expect(isEntityMatch({ github: 'alice' }, undefined, 'ALICE')).toBe(true);
  });

  it('does not match different github username', () => {
    expect(isEntityMatch({ github: 'alice' }, undefined, 'bob')).toBe(false);
  });

  it('matches when either agent or github matches', () => {
    expect(isEntityMatch({ agent: 'a1', github: 'alice' }, 'a1', 'bob')).toBe(true);
    expect(isEntityMatch({ agent: 'a1', github: 'alice' }, 'a2', 'alice')).toBe(true);
  });

  it('does not match when neither matches', () => {
    expect(isEntityMatch({ agent: 'a1', github: 'alice' }, 'a2', 'bob')).toBe(false);
  });

  it('does not match when identifiers are undefined', () => {
    expect(isEntityMatch({ agent: 'a1' }, undefined, undefined)).toBe(false);
    expect(isEntityMatch({ github: 'alice' }, undefined, undefined)).toBe(false);
  });

  it('handles entry with no fields', () => {
    expect(isEntityMatch({}, 'a1', 'alice')).toBe(false);
  });
});
