import { describe, it, expect, vi } from 'vitest';
import {
  parseReviewConfig,
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
    expect(config.reviewer.allowAnonymous).toBe(false);
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

  it('parses allow_anonymous: false in reviewer section', () => {
    const result = parseReviewConfig(
      'version: 1\nprompt: test\nreviewer:\n  allow_anonymous: false',
    ) as ReviewConfig;
    expect(result.reviewer.allowAnonymous).toBe(false);
  });

  it('defaults allowAnonymous to true when absent', () => {
    const result = parseReviewConfig(MINIMAL_CONFIG) as ReviewConfig;
    expect(result.reviewer.allowAnonymous).toBe(true);
  });

  it('defaults allowAnonymous to true for invalid value', () => {
    const result = parseReviewConfig(
      'version: 1\nprompt: test\nreviewer:\n  allow_anonymous: "yes"',
    ) as ReviewConfig;
    expect(result.reviewer.allowAnonymous).toBe(true);
  });

  it('parses allow_anonymous: true explicitly', () => {
    const result = parseReviewConfig(
      'version: 1\nprompt: test\nreviewer:\n  allow_anonymous: true',
    ) as ReviewConfig;
    expect(result.reviewer.allowAnonymous).toBe(true);
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
    expect(DEFAULT_REVIEW_CONFIG.reviewer.allowAnonymous).toBe(true);
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

  it('filters out entries without agent field', () => {
    const config = parseReviewConfig(
      'version: 1\nprompt: test\nsummarizer:\n  preferred:\n    - agent: agent-abc\n    - user: alice\n    - notanagent: true',
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
