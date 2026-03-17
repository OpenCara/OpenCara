import { describe, it, expect } from 'vitest';
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
  preferred_tools:
    - claude-code
    - codex
  min_reputation: 0.6
reviewer:
  whitelist:
    - user: alice
    - agent: abc-123
  blacklist:
    - user: bob
summarizer:
  whitelist:
    - user: alice
  blacklist:
    - user: charlie
timeout: 15m
auto_approve:
  enabled: false
  conditions:
    - type: lint_only
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
    expect(config.agents.preferredTools).toEqual(['claude-code', 'codex']);
    expect(config.agents.minReputation).toBe(0.6);
    expect(config.reviewer.whitelist).toEqual([{ user: 'alice' }, { agent: 'abc-123' }]);
    expect(config.reviewer.blacklist).toEqual([{ user: 'bob' }]);
    expect(config.summarizer.whitelist).toEqual([{ user: 'alice' }]);
    expect(config.summarizer.blacklist).toEqual([{ user: 'charlie' }]);
    expect(config.timeout).toBe('15m');
    expect(config.autoApprove.enabled).toBe(false);
    expect(config.autoApprove.conditions).toEqual([{ type: 'lint_only' }]);
  });

  it('parses a minimal config with defaults', () => {
    const result = parseReviewConfig(MINIMAL_CONFIG);
    expect('error' in result).toBe(false);
    const config = result as ReviewConfig;
    expect(config.version).toBe(1);
    expect(config.prompt).toBe('Review this code.');
    expect(config.agents.reviewCount).toBe(1);
    expect(config.agents.preferredTools).toEqual([]);
    expect(config.agents.minReputation).toBe(0.0);
    expect(config.reviewer.whitelist).toEqual([]);
    expect(config.reviewer.blacklist).toEqual([]);
    expect(config.summarizer.whitelist).toEqual([]);
    expect(config.summarizer.blacklist).toEqual([]);
    expect(config.timeout).toBe('10m');
    expect(config.autoApprove.enabled).toBe(false);
    expect(config.autoApprove.conditions).toEqual([]);
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

  it('clamps min_reputation to range 0.0-1.0', () => {
    const low = parseReviewConfig(
      'version: 1\nprompt: test\nagents:\n  min_reputation: -0.5',
    ) as ReviewConfig;
    expect(low.agents.minReputation).toBe(0.0);

    const high = parseReviewConfig(
      'version: 1\nprompt: test\nagents:\n  min_reputation: 1.5',
    ) as ReviewConfig;
    expect(high.agents.minReputation).toBe(1.0);
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
});

describe('DEFAULT_REVIEW_CONFIG', () => {
  it('is a valid ReviewConfig', () => {
    expect(validateReviewConfig(DEFAULT_REVIEW_CONFIG)).toBe(true);
  });

  it('has sensible defaults', () => {
    expect(DEFAULT_REVIEW_CONFIG.version).toBe(1);
    expect(DEFAULT_REVIEW_CONFIG.prompt).toBeTruthy();
    expect(DEFAULT_REVIEW_CONFIG.agents.reviewCount).toBe(1);
    expect(DEFAULT_REVIEW_CONFIG.agents.minReputation).toBe(0);
    expect(DEFAULT_REVIEW_CONFIG.timeout).toBe('10m');
    expect(DEFAULT_REVIEW_CONFIG.autoApprove.enabled).toBe(false);
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
