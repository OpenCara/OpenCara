import { describe, it, expect, vi } from 'vitest';
import {
  parseOpenCaraConfig,
  parseReviewConfig,
  parseEntityList,
  isEntityMatch,
  isEventTriggerEnabled,
  isCommentTriggerEnabled,
  isLabelTriggerEnabled,
  isStatusTriggerEnabled,
  validateReviewConfig,
  validateOpenCaraConfig,
  resolveNamedAgent,
  DEFAULT_REVIEW_CONFIG,
  DEFAULT_OPENCARA_CONFIG,
  DEFAULT_MODEL_DIVERSITY_GRACE_MS,
  type ReviewConfig,
  type OpenCaraConfig,
  type ImplementConfig,
  type FixConfig,
} from '../review-config.js';

// ── Legacy flat format (backward-compat via parseReviewConfig) ──

const VALID_FULL_LEGACY_CONFIG = `
version = 1
prompt = """
Focus on code quality, security, and test coverage.
This project uses TypeScript + React, following ESLint standards.
"""
timeout = "15m"

[agents]
review_count = 2
preferred_models = ["claude-opus-4-6", "glm-5"]
preferred_tools = ["claude-code", "codex"]

[reviewer]

[[reviewer.whitelist]]
agent = "abc-123"

[[reviewer.blacklist]]
agent = "agent-bad"

[[summarizer.whitelist]]
agent = "agent-synth"

[[summarizer.blacklist]]
agent = "agent-spam"
`;

const MINIMAL_LEGACY_CONFIG = `
version = 1
prompt = "Review this code."
`;

describe('parseReviewConfig (legacy backward compat)', () => {
  it('parses a full valid legacy config', () => {
    const result = parseReviewConfig(VALID_FULL_LEGACY_CONFIG);
    expect('error' in result).toBe(false);
    const config = result as ReviewConfig;
    expect(config.prompt).toContain('Focus on code quality');
    expect(config.agentCount).toBe(2);
    expect(config.preferredModels).toEqual(['claude-opus-4-6', 'glm-5']);
    expect(config.preferredTools).toEqual(['claude-code', 'codex']);
    expect(config.reviewer.whitelist).toEqual([{ agent: 'abc-123' }]);
    expect(config.reviewer.blacklist).toEqual([{ agent: 'agent-bad' }]);
    expect(config.summarizer.whitelist).toEqual([{ agent: 'agent-synth' }]);
    expect(config.summarizer.blacklist).toEqual([{ agent: 'agent-spam' }]);
    expect(config.timeout).toBe('15m');
  });

  it('parses a minimal config with defaults', () => {
    const result = parseReviewConfig(MINIMAL_LEGACY_CONFIG);
    expect('error' in result).toBe(false);
    const config = result as ReviewConfig;
    expect(config.prompt).toBe('Review this code.');
    expect(config.agentCount).toBe(1);
    expect(config.preferredTools).toEqual([]);
    expect(config.reviewer.whitelist).toEqual([]);
    expect(config.reviewer.blacklist).toEqual([]);
    expect(config.summarizer.whitelist).toEqual([]);
    expect(config.summarizer.blacklist).toEqual([]);
    expect(config.summarizer.preferred).toEqual([]);
    expect(config.timeout).toBe('10m');
  });

  it('returns error for invalid TOML syntax', () => {
    const result = parseReviewConfig('{ invalid toml: [');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('Invalid TOML syntax');
  });

  it('returns error for bare string (invalid TOML)', () => {
    const result = parseReviewConfig('just a string');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('Invalid TOML syntax');
  });

  it('returns error when version is missing', () => {
    const result = parseReviewConfig('prompt = "hello"');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('Missing required field: version');
  });

  it('returns error when version is not a number', () => {
    const result = parseReviewConfig('version = "one"\nprompt = "hello"');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('Field "version" must be a number');
  });

  it('returns default review section when no prompt or [review] section', () => {
    const result = parseReviewConfig('version = 1');
    expect('error' in result).toBe(false);
    const config = result as ReviewConfig;
    // Returns DEFAULT_REVIEW_CONFIG when no review section found
    expect(config.prompt).toBe(DEFAULT_REVIEW_CONFIG.prompt);
  });

  it('returns default when prompt is not a string (no valid review section)', () => {
    const result = parseReviewConfig('version = 1\nprompt = 123');
    expect('error' in result).toBe(false);
    // Non-string prompt at top level means no legacy review section detected → defaults
    expect((result as ReviewConfig).prompt).toBe(DEFAULT_REVIEW_CONFIG.prompt);
  });

  it('clamps review_count to range 1-10', () => {
    const low = parseReviewConfig(
      'version = 1\nprompt = "test"\n[agents]\nreview_count = 0',
    ) as ReviewConfig;
    expect(low.agentCount).toBe(1);

    const high = parseReviewConfig(
      'version = 1\nprompt = "test"\n[agents]\nreview_count = 99',
    ) as ReviewConfig;
    expect(high.agentCount).toBe(10);
  });

  it('uses default timeout for invalid format', () => {
    const result = parseReviewConfig(
      'version = 1\nprompt = "test"\ntimeout = "2h"',
    ) as ReviewConfig;
    expect(result.timeout).toBe('10m');
  });

  it('uses default timeout for out-of-range minutes', () => {
    const result = parseReviewConfig(
      'version = 1\nprompt = "test"\ntimeout = "60m"',
    ) as ReviewConfig;
    expect(result.timeout).toBe('10m');
  });

  it('accepts valid timeout values', () => {
    const r1 = parseReviewConfig('version = 1\nprompt = "test"\ntimeout = "1m"') as ReviewConfig;
    expect(r1.timeout).toBe('1m');

    const r30 = parseReviewConfig('version = 1\nprompt = "test"\ntimeout = "30m"') as ReviewConfig;
    expect(r30.timeout).toBe('30m');
  });

  it('filters non-string values from preferred_tools', () => {
    const result = parseReviewConfig(
      'version = 1\nprompt = "test"\n[agents]\npreferred_tools = ["claude-code", 123, "codex"]',
    ) as ReviewConfig;
    expect(result.preferredTools).toEqual(['claude-code', 'codex']);
  });

  it('silently ignores allow_anonymous field in reviewer section', () => {
    const result = parseReviewConfig(
      'version = 1\nprompt = "test"\n[reviewer]\nallow_anonymous = false',
    ) as ReviewConfig;
    expect('error' in result).toBe(false);
  });
});

// ── New format: parseOpenCaraConfig ──

const VALID_NEW_FORMAT = `
version = 1

[review]
prompt = "Review this PR for bugs."
agent_count = 3
timeout = "15m"
preferred_models = ["claude-opus-4-6"]
preferred_tools = ["claude"]

[review.trigger]
on = ["opened", "synchronize"]
comment = "/review"
skip = ["draft"]

[[review.reviewer.whitelist]]
agent = "agent-a"

[[review.summarizer.preferred]]
github = "alice"
`;

describe('parseOpenCaraConfig (new format)', () => {
  it('parses a full new-format config', () => {
    const result = parseOpenCaraConfig(VALID_NEW_FORMAT);
    expect('error' in result).toBe(false);
    const config = result as OpenCaraConfig;
    expect(config.version).toBe(1);
    expect(config.review).toBeDefined();
    expect(config.review!.prompt).toBe('Review this PR for bugs.');
    expect(config.review!.agentCount).toBe(3);
    expect(config.review!.timeout).toBe('15m');
    expect(config.review!.preferredModels).toEqual(['claude-opus-4-6']);
    expect(config.review!.preferredTools).toEqual(['claude']);
    expect(config.review!.trigger.events).toEqual(['opened', 'synchronize']);
    expect(config.review!.trigger.comment).toBe('/review');
    expect(config.review!.reviewer.whitelist).toEqual([{ agent: 'agent-a' }]);
    expect(config.review!.summarizer.preferred).toEqual([{ github: 'alice' }]);
  });

  it('parses config with only version (no sections)', () => {
    const result = parseOpenCaraConfig('version = 1');
    expect('error' in result).toBe(false);
    const config = result as OpenCaraConfig;
    expect(config.version).toBe(1);
    expect(config.review).toBeUndefined();
    expect(config.dedup).toBeUndefined();
    expect(config.triage).toBeUndefined();
  });

  it('returns error when [review] prompt is missing', () => {
    const result = parseOpenCaraConfig('version = 1\n[review]\nagent_count = 2');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('Missing required field: review.prompt');
  });

  it('clamps agent_count to range 1-10', () => {
    const low = parseOpenCaraConfig(
      'version = 1\n[review]\nprompt = "test"\nagent_count = 0',
    ) as OpenCaraConfig;
    expect(low.review!.agentCount).toBe(1);

    const high = parseOpenCaraConfig(
      'version = 1\n[review]\nprompt = "test"\nagent_count = 99',
    ) as OpenCaraConfig;
    expect(high.review!.agentCount).toBe(10);
  });

  it('parses [[review.agents]] per-slot overrides', () => {
    const toml = `
version = 1
[review]
prompt = "Review this"
agent_count = 3

[[review.agents]]
prompt = "Focus on security"
preferred_models = ["claude-opus-4-6"]

[[review.agents]]
prompt = "Focus on performance"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.review!.agents).toHaveLength(2);
    expect(result.review!.agents![0].prompt).toBe('Focus on security');
    expect(result.review!.agents![0].preferredModels).toEqual(['claude-opus-4-6']);
    expect(result.review!.agents![1].prompt).toBe('Focus on performance');
    expect(result.review!.agents![1].preferredModels).toBeUndefined();
  });

  it('uses defaults when trigger section is missing', () => {
    const result = parseOpenCaraConfig('version = 1\n[review]\nprompt = "test"') as OpenCaraConfig;
    expect(result.review!.trigger.events).toEqual(['opened']);
    expect(result.review!.trigger.comment).toBe('/opencara review');
    expect(result.review!.trigger.skip).toEqual(['draft']);
  });
});

// ── Dedup section ──

describe('parseOpenCaraConfig — dedup section', () => {
  it('parses dedup.prs section', () => {
    const toml = `
version = 1
[dedup.prs]
prompt = "Check for duplicate PRs"
enabled = true
agent_count = 1
index_issue = 42
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.dedup).toBeDefined();
    expect(result.dedup!.prs).toBeDefined();
    expect(result.dedup!.prs!.prompt).toBe('Check for duplicate PRs');
    expect(result.dedup!.prs!.enabled).toBe(true);
    expect(result.dedup!.prs!.agentCount).toBe(1);
    expect(result.dedup!.prs!.indexIssue).toBe(42);
  });

  it('parses dedup.issues section with includeClosed', () => {
    const toml = `
version = 1
[dedup.issues]
prompt = "Check for duplicate issues"
enabled = true
include_closed = true
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.dedup!.issues).toBeDefined();
    expect(result.dedup!.issues!.prompt).toBe('Check for duplicate issues');
    expect(result.dedup!.issues!.enabled).toBe(true);
    expect(result.dedup!.issues!.includeClosed).toBe(true);
  });

  it('defaults enabled to true for dedup targets', () => {
    const toml = `
version = 1
[dedup.prs]
prompt = "Check dups"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.dedup!.prs!.enabled).toBe(true);
  });

  it('dedup section absent when not in config', () => {
    const result = parseOpenCaraConfig('version = 1\n[review]\nprompt = "test"') as OpenCaraConfig;
    expect(result.dedup).toBeUndefined();
  });
});

// ── Triage section ──

describe('parseOpenCaraConfig — triage section', () => {
  it('parses triage section with all fields', () => {
    const toml = `
version = 1
[triage]
prompt = "Triage this issue"
enabled = true
default_mode = "rewrite"
auto_label = true
triggers = ["bug", "feature"]
agent_count = 2
timeout = "5m"

[triage.author_modes]
alice = "rewrite"
bob = "comment"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.triage).toBeDefined();
    expect(result.triage!.prompt).toBe('Triage this issue');
    expect(result.triage!.enabled).toBe(true);
    expect(result.triage!.defaultMode).toBe('rewrite');
    expect(result.triage!.autoLabel).toBe(true);
    expect(result.triage!.trigger.events).toEqual(['bug', 'feature']);
    expect(result.triage!.agentCount).toBe(2);
    expect(result.triage!.timeout).toBe('5m');
    expect(result.triage!.authorModes).toEqual({ alice: 'rewrite', bob: 'comment' });
  });

  it('defaults triage fields', () => {
    const toml = `
version = 1
[triage]
prompt = "Triage"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.triage!.enabled).toBe(true);
    expect(result.triage!.defaultMode).toBe('comment');
    expect(result.triage!.autoLabel).toBe(false);
    expect(result.triage!.trigger.events).toEqual(['opened']);
    expect(result.triage!.trigger.comment).toBe('/opencara triage');
    expect(result.triage!.authorModes).toBeUndefined();
  });

  it('rejects invalid author_modes values', () => {
    const toml = `
version = 1
[triage]
prompt = "Triage"
[triage.author_modes]
alice = "rewrite"
bob = "invalid"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    // Invalid values are silently skipped
    expect(result.triage!.authorModes).toEqual({ alice: 'rewrite' });
  });

  it('uses explicit triggers when provided', () => {
    const toml = `
version = 1
[triage]
prompt = "Triage"
triggers = ["opened", "edited"]
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.triage!.trigger.events).toEqual(['opened', 'edited']);
  });

  it('uses explicit empty triggers when provided', () => {
    const toml = `
version = 1
[triage]
prompt = "Triage"
triggers = []
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.triage!.trigger.events).toEqual([]);
  });

  it('defaults default_mode to comment for invalid value', () => {
    const toml = `
version = 1
[triage]
prompt = "Triage"
default_mode = "invalid"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.triage!.defaultMode).toBe('comment');
  });
});

// ── Legacy format backward compat via parseOpenCaraConfig ──

describe('parseOpenCaraConfig — legacy flat format', () => {
  it('detects legacy format and wraps in review section', () => {
    const result = parseOpenCaraConfig(MINIMAL_LEGACY_CONFIG) as OpenCaraConfig;
    expect(result.version).toBe(1);
    expect(result.review).toBeDefined();
    expect(result.review!.prompt).toBe('Review this code.');
    expect(result.review!.agentCount).toBe(1);
  });

  it('parses full legacy config into review section', () => {
    const result = parseOpenCaraConfig(VALID_FULL_LEGACY_CONFIG) as OpenCaraConfig;
    expect(result.version).toBe(1);
    expect(result.review!.prompt).toContain('Focus on code quality');
    expect(result.review!.agentCount).toBe(2);
    expect(result.review!.preferredModels).toEqual(['claude-opus-4-6', 'glm-5']);
    expect(result.review!.reviewer.whitelist).toEqual([{ agent: 'abc-123' }]);
  });
});

// ── DEFAULT configs ──

describe('DEFAULT_REVIEW_CONFIG', () => {
  it('is a valid ReviewConfig', () => {
    expect(validateReviewConfig(DEFAULT_REVIEW_CONFIG)).toBe(true);
  });

  it('has sensible defaults', () => {
    expect(DEFAULT_REVIEW_CONFIG.prompt).toBeTruthy();
    expect(DEFAULT_REVIEW_CONFIG.agentCount).toBe(1);
    expect(DEFAULT_REVIEW_CONFIG.timeout).toBe('10m');
    expect(DEFAULT_REVIEW_CONFIG.trigger.events).toEqual(['opened']);
    expect(DEFAULT_REVIEW_CONFIG.trigger.comment).toBe('/opencara review');
    expect(DEFAULT_REVIEW_CONFIG.trigger.skip).toEqual(['draft']);
  });
});

describe('DEFAULT_OPENCARA_CONFIG', () => {
  it('is a valid OpenCaraConfig', () => {
    expect(validateOpenCaraConfig(DEFAULT_OPENCARA_CONFIG)).toBe(true);
  });

  it('has a review section', () => {
    expect(DEFAULT_OPENCARA_CONFIG.review).toBeDefined();
    expect(DEFAULT_OPENCARA_CONFIG.review!.prompt).toBeTruthy();
  });
});

// ── Trigger config ──

describe('trigger config parsing', () => {
  it('parses custom trigger config (legacy)', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[trigger]\non = ["opened", "synchronize"]\ncomment = "/review"\nskip = ["draft", "label:wip"]',
    );
    expect('error' in config).toBe(false);
    if (!('error' in config)) {
      expect(config.trigger.events).toEqual(['opened', 'synchronize']);
      expect(config.trigger.comment).toBe('/review');
      expect(config.trigger.skip).toEqual(['draft', 'label:wip']);
    }
  });

  it('uses defaults when trigger section is missing', () => {
    const config = parseReviewConfig('version = 1\nprompt = "test"');
    expect('error' in config).toBe(false);
    if (!('error' in config)) {
      expect(config.trigger.events).toEqual(['opened']);
      expect(config.trigger.comment).toBe('/opencara review');
      expect(config.trigger.skip).toEqual(['draft']);
    }
  });

  it('uses defaults for individual missing trigger fields', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[trigger]\non = ["ready_for_review"]',
    );
    expect('error' in config).toBe(false);
    if (!('error' in config)) {
      expect(config.trigger.events).toEqual(['ready_for_review']);
      expect(config.trigger.comment).toBe('/opencara review');
      expect(config.trigger.skip).toEqual(['draft']);
    }
  });
});

// ── Summarizer parsing ──

describe('summarizer.preferred parsing', () => {
  it('parses preferred agent list (legacy)', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[[summarizer.preferred]]\nagent = "agent-abc"\n[[summarizer.preferred]]\nagent = "agent-def"',
    ) as ReviewConfig;
    expect(config.summarizer.preferred).toEqual([{ agent: 'agent-abc' }, { agent: 'agent-def' }]);
  });

  it('defaults to empty array when preferred is not set', () => {
    const config = parseReviewConfig(MINIMAL_LEGACY_CONFIG) as ReviewConfig;
    expect(config.summarizer.preferred).toEqual([]);
  });

  it('filters out entries without agent or github field', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[[summarizer.preferred]]\nagent = "agent-abc"\n[[summarizer.preferred]]\nnotanagent = true',
    ) as ReviewConfig;
    expect(config.summarizer.preferred).toEqual([{ agent: 'agent-abc' }]);
  });

  it('parses full config with preferred alongside whitelist/blacklist', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[[summarizer.whitelist]]\nagent = "agent-a"\n[[summarizer.blacklist]]\nagent = "agent-b"\n[[summarizer.preferred]]\nagent = "agent-a"',
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
      'version = 1\nprompt = "test"\n[[reviewer.whitelist]]\nuser = "alice"\n[[reviewer.whitelist]]\nagent = "agent-abc"',
    ) as ReviewConfig;
    expect(config.reviewer.whitelist).toEqual([{ agent: 'agent-abc' }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring "user" entry'));
    warnSpy.mockRestore();
  });

  it('keeps entries that have both user and agent fields (agent wins)', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[[reviewer.whitelist]]\nuser = "alice"\nagent = "agent-abc"',
    ) as ReviewConfig;
    expect(config.reviewer.whitelist).toEqual([{ agent: 'agent-abc' }]);
  });

  it('produces empty list when all entries are user-only', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[[reviewer.blacklist]]\nuser = "bob"\n[[reviewer.blacklist]]\nuser = "charlie"',
    ) as ReviewConfig;
    expect(config.reviewer.blacklist).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});

describe('validateReviewConfig', () => {
  it('returns true for valid config', () => {
    const config = parseReviewConfig(VALID_FULL_LEGACY_CONFIG);
    expect('error' in config).toBe(false);
    expect(validateReviewConfig(config)).toBe(true);
  });

  it('returns false for null', () => {
    expect(validateReviewConfig(null)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(validateReviewConfig('hello')).toBe(false);
  });

  it('returns true for object with prompt', () => {
    expect(validateReviewConfig({ prompt: 'test' })).toBe(true);
  });

  it('returns false for object missing prompt', () => {
    expect(validateReviewConfig({ version: 1 })).toBe(false);
  });

  it('returns false for object with wrong prompt type', () => {
    expect(validateReviewConfig({ prompt: 123 })).toBe(false);
  });
});

// ── GitHub entity entries ──

describe('GitHub entity entries in entity lists', () => {
  it('parses github entries in whitelist', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[[reviewer.whitelist]]\ngithub = "alice"\n[[reviewer.whitelist]]\nagent = "agent-abc"',
    ) as ReviewConfig;
    expect(config.reviewer.whitelist).toEqual([{ github: 'alice' }, { agent: 'agent-abc' }]);
  });

  it('parses github entries in blacklist', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[[summarizer.blacklist]]\ngithub = "mallory"',
    ) as ReviewConfig;
    expect(config.summarizer.blacklist).toEqual([{ github: 'mallory' }]);
  });

  it('parses entries with both agent and github', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[[summarizer.preferred]]\nagent = "agent-a"\ngithub = "alice"',
    ) as ReviewConfig;
    expect(config.summarizer.preferred).toEqual([{ agent: 'agent-a', github: 'alice' }]);
  });

  it('parses github entries in summarizer preferred list', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[[summarizer.preferred]]\ngithub = "alice"\n[[summarizer.preferred]]\ngithub = "bob"',
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
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\nsummarizer = "alice"',
    ) as ReviewConfig;
    expect(config.summarizer.preferred).toEqual([{ github: 'alice' }]);
    expect(config.summarizer.whitelist).toEqual([]);
    expect(config.summarizer.blacklist).toEqual([]);
  });

  it('parses "only" string as whitelist with single github entry', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[summarizer]\nonly = "alice"',
    ) as ReviewConfig;
    expect(config.summarizer.whitelist).toEqual([{ github: 'alice' }]);
    expect(config.summarizer.preferred).toEqual([]);
    expect(config.summarizer.blacklist).toEqual([]);
  });

  it('parses "only" list as whitelist with multiple github entries', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[summarizer]\nonly = ["alice", "bob"]',
    ) as ReviewConfig;
    expect(config.summarizer.whitelist).toEqual([{ github: 'alice' }, { github: 'bob' }]);
    expect(config.summarizer.preferred).toEqual([]);
    expect(config.summarizer.blacklist).toEqual([]);
  });

  it('parses full object form', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[[summarizer.whitelist]]\nagent = "agent-a"\n[[summarizer.blacklist]]\ngithub = "mallory"\n[[summarizer.preferred]]\ngithub = "alice"',
    ) as ReviewConfig;
    expect(config.summarizer.whitelist).toEqual([{ agent: 'agent-a' }]);
    expect(config.summarizer.blacklist).toEqual([{ github: 'mallory' }]);
    expect(config.summarizer.preferred).toEqual([{ github: 'alice' }]);
  });

  it('returns defaults when summarizer is not present', () => {
    const config = parseReviewConfig(MINIMAL_LEGACY_CONFIG) as ReviewConfig;
    expect(config.summarizer.whitelist).toEqual([]);
    expect(config.summarizer.blacklist).toEqual([]);
    expect(config.summarizer.preferred).toEqual([]);
  });

  it('returns defaults when "only" has invalid value', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[summarizer]\nonly = 123',
    ) as ReviewConfig;
    expect(config.summarizer.whitelist).toEqual([]);
    expect(config.summarizer.preferred).toEqual([]);
  });

  it('filters non-string entries in "only" list', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[summarizer]\nonly = ["alice", 123, "bob"]',
    ) as ReviewConfig;
    expect(config.summarizer.whitelist).toEqual([{ github: 'alice' }, { github: 'bob' }]);
  });
});

// ── Summarizer preferred_models parsing ──

describe('summarizer.preferred_models parsing', () => {
  it('parses preferred_models in full object form (legacy)', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[summarizer]\npreferred_models = ["claude-opus-4-6", "gpt-5.4"]',
    ) as ReviewConfig;
    expect(config.summarizer.preferredModels).toEqual(['claude-opus-4-6', 'gpt-5.4']);
  });

  it('parses preferred_models alongside "only" string', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[summarizer]\nonly = "alice"\npreferred_models = ["claude-opus-4-6"]',
    ) as ReviewConfig;
    expect(config.summarizer.whitelist).toEqual([{ github: 'alice' }]);
    expect(config.summarizer.preferredModels).toEqual(['claude-opus-4-6']);
  });

  it('parses preferred_models alongside "only" list', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[summarizer]\nonly = ["alice", "bob"]\npreferred_models = ["gpt-5.4"]',
    ) as ReviewConfig;
    expect(config.summarizer.whitelist).toEqual([{ github: 'alice' }, { github: 'bob' }]);
    expect(config.summarizer.preferredModels).toEqual(['gpt-5.4']);
  });

  it('defaults to empty array when preferred_models is not set', () => {
    const config = parseReviewConfig(MINIMAL_LEGACY_CONFIG) as ReviewConfig;
    expect(config.summarizer.preferredModels).toEqual([]);
  });

  it('defaults to empty array for string shorthand (no object)', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\nsummarizer = "alice"',
    ) as ReviewConfig;
    expect(config.summarizer.preferredModels).toEqual([]);
  });

  it('filters non-string entries from preferred_models', () => {
    const config = parseReviewConfig(
      'version = 1\nprompt = "test"\n[summarizer]\npreferred_models = ["claude-opus-4-6", 123, "gpt-5.4"]',
    ) as ReviewConfig;
    expect(config.summarizer.preferredModels).toEqual(['claude-opus-4-6', 'gpt-5.4']);
  });

  it('parses preferred_models in new format [review.summarizer]', () => {
    const toml = `
version = 1
[review]
prompt = "Review this"
[review.summarizer]
only = "quabug"
preferred_models = ["claude-opus-4-6", "gpt-5.4"]
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.review!.summarizer.whitelist).toEqual([{ github: 'quabug' }]);
    expect(result.review!.summarizer.preferredModels).toEqual(['claude-opus-4-6', 'gpt-5.4']);
  });

  it('parses preferred_models alongside entity preferences in new format', () => {
    const toml = `
version = 1
[review]
prompt = "Review this"
preferred_models = ["claude-opus-4-6"]
[review.summarizer]
preferred_models = ["gpt-5.4"]
[[review.summarizer.preferred]]
github = "alice"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.review!.preferredModels).toEqual(['claude-opus-4-6']);
    expect(result.review!.summarizer.preferred).toEqual([{ github: 'alice' }]);
    expect(result.review!.summarizer.preferredModels).toEqual(['gpt-5.4']);
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

// ── model_diversity_grace parsing ──

describe('model_diversity_grace parsing', () => {
  it('defaults to 30s when not set (new format)', () => {
    const toml = `
version = 1
[review]
prompt = "test"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.review!.modelDiversityGraceMs).toBe(DEFAULT_MODEL_DIVERSITY_GRACE_MS);
  });

  it('defaults to 30s when not set (legacy format)', () => {
    const config = parseReviewConfig('version = 1\nprompt = "test"') as ReviewConfig;
    expect(config.modelDiversityGraceMs).toBe(DEFAULT_MODEL_DIVERSITY_GRACE_MS);
  });

  it('parses "60s" as 60000ms', () => {
    const toml = `
version = 1
[review]
prompt = "test"
model_diversity_grace = "60s"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.review!.modelDiversityGraceMs).toBe(60_000);
  });

  it('parses "0s" to disable', () => {
    const toml = `
version = 1
[review]
prompt = "test"
model_diversity_grace = "0s"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.review!.modelDiversityGraceMs).toBe(0);
  });

  it('parses "0" to disable', () => {
    const toml = `
version = 1
[review]
prompt = "test"
model_diversity_grace = "0"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.review!.modelDiversityGraceMs).toBe(0);
  });

  it('clamps to max 300s (5 minutes)', () => {
    const toml = `
version = 1
[review]
prompt = "test"
model_diversity_grace = "600s"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.review!.modelDiversityGraceMs).toBe(300_000);
  });

  it('uses default for invalid string format', () => {
    const toml = `
version = 1
[review]
prompt = "test"
model_diversity_grace = "30m"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.review!.modelDiversityGraceMs).toBe(DEFAULT_MODEL_DIVERSITY_GRACE_MS);
  });

  it('applies to dedup sections', () => {
    const toml = `
version = 1
[dedup.prs]
prompt = "check dupes"
model_diversity_grace = "45s"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.dedup!.prs!.modelDiversityGraceMs).toBe(45_000);
  });

  it('applies to triage section', () => {
    const toml = `
version = 1
[triage]
prompt = "triage"
model_diversity_grace = "20s"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.triage!.modelDiversityGraceMs).toBe(20_000);
  });

  it('applies to implement section', () => {
    const toml = `
version = 1
[implement]
prompt = "implement"
model_diversity_grace = "15s"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.implement!.modelDiversityGraceMs).toBe(15_000);
  });

  it('applies to fix section', () => {
    const toml = `
version = 1
[fix]
prompt = "fix"
model_diversity_grace = "10s"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.fix!.modelDiversityGraceMs).toBe(10_000);
  });
});

// ── Implement section ──

describe('parseOpenCaraConfig — implement section', () => {
  it('parses implement section with all fields', () => {
    const toml = `
version = 1
[implement]
prompt = "Implement the requested feature"
enabled = true
agent_count = 2
timeout = "15m"
preferred_models = ["claude-opus-4-6"]
preferred_tools = ["claude"]
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.implement).toBeDefined();
    expect(result.implement!.prompt).toBe('Implement the requested feature');
    expect(result.implement!.enabled).toBe(true);
    expect(result.implement!.agentCount).toBe(2);
    expect(result.implement!.timeout).toBe('15m');
    expect(result.implement!.preferredModels).toEqual(['claude-opus-4-6']);
    expect(result.implement!.preferredTools).toEqual(['claude']);
  });

  it('defaults implement fields', () => {
    const toml = `
version = 1
[implement]
prompt = "Implement changes"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.implement!.enabled).toBe(true);
    expect(result.implement!.agentCount).toBe(1);
    expect(result.implement!.timeout).toBe('10m');
    expect(result.implement!.preferredModels).toEqual([]);
    expect(result.implement!.preferredTools).toEqual([]);
    expect(result.implement!.modelDiversityGraceMs).toBe(DEFAULT_MODEL_DIVERSITY_GRACE_MS);
  });

  it('parses implement with enabled = false', () => {
    const toml = `
version = 1
[implement]
prompt = "Implement"
enabled = false
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.implement!.enabled).toBe(false);
  });

  it('uses default prompt when prompt is absent', () => {
    const toml = `
version = 1
[implement]
agent_count = 1
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.implement!.prompt).toBe('Implement the requested changes.');
  });

  it('implement section absent when not in config', () => {
    const result = parseOpenCaraConfig('version = 1\n[review]\nprompt = "test"') as OpenCaraConfig;
    expect(result.implement).toBeUndefined();
  });

  it('clamps implement agent_count to range 1-10', () => {
    const low = parseOpenCaraConfig(
      'version = 1\n[implement]\nprompt = "test"\nagent_count = 0',
    ) as OpenCaraConfig;
    expect(low.implement!.agentCount).toBe(1);

    const high = parseOpenCaraConfig(
      'version = 1\n[implement]\nprompt = "test"\nagent_count = 99',
    ) as OpenCaraConfig;
    expect(high.implement!.agentCount).toBe(10);
  });
});

// ── Fix section ──

describe('parseOpenCaraConfig — fix section', () => {
  it('parses fix section with all fields', () => {
    const toml = `
version = 1
[fix]
prompt = "Fix the review comments"
enabled = true
agent_count = 1
timeout = "5m"
preferred_models = ["claude-sonnet-4-6"]
preferred_tools = ["claude"]
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.fix).toBeDefined();
    expect(result.fix!.prompt).toBe('Fix the review comments');
    expect(result.fix!.enabled).toBe(true);
    expect(result.fix!.agentCount).toBe(1);
    expect(result.fix!.timeout).toBe('5m');
    expect(result.fix!.preferredModels).toEqual(['claude-sonnet-4-6']);
    expect(result.fix!.preferredTools).toEqual(['claude']);
  });

  it('defaults fix fields', () => {
    const toml = `
version = 1
[fix]
prompt = "Fix comments"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.fix!.enabled).toBe(true);
    expect(result.fix!.agentCount).toBe(1);
    expect(result.fix!.timeout).toBe('10m');
    expect(result.fix!.preferredModels).toEqual([]);
    expect(result.fix!.preferredTools).toEqual([]);
    expect(result.fix!.modelDiversityGraceMs).toBe(DEFAULT_MODEL_DIVERSITY_GRACE_MS);
  });

  it('parses fix with enabled = false', () => {
    const toml = `
version = 1
[fix]
prompt = "Fix"
enabled = false
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.fix!.enabled).toBe(false);
  });

  it('uses default prompt when prompt is absent', () => {
    const toml = `
version = 1
[fix]
agent_count = 1
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.fix!.prompt).toBe('Fix the review comments.');
  });

  it('fix section absent when not in config', () => {
    const result = parseOpenCaraConfig('version = 1\n[review]\nprompt = "test"') as OpenCaraConfig;
    expect(result.fix).toBeUndefined();
  });

  it('clamps fix agent_count to range 1-10', () => {
    const low = parseOpenCaraConfig(
      'version = 1\n[fix]\nprompt = "test"\nagent_count = 0',
    ) as OpenCaraConfig;
    expect(low.fix!.agentCount).toBe(1);

    const high = parseOpenCaraConfig(
      'version = 1\n[fix]\nprompt = "test"\nagent_count = 99',
    ) as OpenCaraConfig;
    expect(high.fix!.agentCount).toBe(10);
  });
});

// ── Combined config ──

describe('parseOpenCaraConfig — combined implement/fix with other sections', () => {
  it('parses config with all sections', () => {
    const toml = `
version = 1

[review]
prompt = "Review this PR"

[dedup.prs]
prompt = "Check dupes"

[triage]
prompt = "Triage issue"

[implement]
prompt = "Implement feature"

[fix]
prompt = "Fix comments"
`;
    const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
    expect(result.review).toBeDefined();
    expect(result.dedup).toBeDefined();
    expect(result.triage).toBeDefined();
    expect(result.implement).toBeDefined();
    expect(result.fix).toBeDefined();
  });
});

// ── Unified trigger config ──

describe('unified trigger config', () => {
  describe('per-feature default triggers', () => {
    it('review defaults: events=["opened"], comment="/opencara review", skip=["draft"]', () => {
      const result = parseOpenCaraConfig(
        'version = 1\n[review]\nprompt = "test"',
      ) as OpenCaraConfig;
      expect(result.review!.trigger.events).toEqual(['opened']);
      expect(result.review!.trigger.comment).toBe('/opencara review');
      expect(result.review!.trigger.skip).toEqual(['draft']);
      expect(result.review!.trigger.label).toBeUndefined();
      expect(result.review!.trigger.status).toBeUndefined();
    });

    it('implement defaults: comment="/opencara go", status="Ready"', () => {
      const result = parseOpenCaraConfig(
        'version = 1\n[implement]\nprompt = "test"',
      ) as OpenCaraConfig;
      expect(result.implement!.trigger.comment).toBe('/opencara go');
      expect(result.implement!.trigger.status).toBe('Ready');
      expect(result.implement!.trigger.events).toBeUndefined();
      expect(result.implement!.trigger.label).toBeUndefined();
      expect(result.implement!.trigger.skip).toBeUndefined();
    });

    it('fix defaults: comment="/opencara fix"', () => {
      const result = parseOpenCaraConfig('version = 1\n[fix]\nprompt = "test"') as OpenCaraConfig;
      expect(result.fix!.trigger.comment).toBe('/opencara fix');
      expect(result.fix!.trigger.events).toBeUndefined();
      expect(result.fix!.trigger.label).toBeUndefined();
      expect(result.fix!.trigger.status).toBeUndefined();
      expect(result.fix!.trigger.skip).toBeUndefined();
    });

    it('triage defaults: events=["opened"], comment="/opencara triage"', () => {
      const result = parseOpenCaraConfig(
        'version = 1\n[triage]\nprompt = "test"',
      ) as OpenCaraConfig;
      expect(result.triage!.trigger.events).toEqual(['opened']);
      expect(result.triage!.trigger.comment).toBe('/opencara triage');
      expect(result.triage!.trigger.label).toBeUndefined();
      expect(result.triage!.trigger.status).toBeUndefined();
      expect(result.triage!.trigger.skip).toBeUndefined();
    });
  });

  describe('explicit disable via false', () => {
    it('comment = false disables default comment trigger on implement', () => {
      const toml = `
version = 1
[implement]
prompt = "test"
[implement.trigger]
comment = false
`;
      const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
      expect(result.implement!.trigger.comment).toBeUndefined();
      expect(result.implement!.trigger.status).toBe('Ready'); // default still active
    });

    it('events = false disables default event trigger on review', () => {
      const toml = `
version = 1
[review]
prompt = "test"
[review.trigger]
events = false
`;
      const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
      expect(result.review!.trigger.events).toBeUndefined();
      expect(result.review!.trigger.comment).toBe('/opencara review'); // default still active
      expect(result.review!.trigger.skip).toEqual(['draft']); // default still active
    });

    it('status = false disables default status trigger on implement', () => {
      const toml = `
version = 1
[implement]
prompt = "test"
[implement.trigger]
status = false
`;
      const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
      expect(result.implement!.trigger.status).toBeUndefined();
      expect(result.implement!.trigger.comment).toBe('/opencara go'); // default still active
    });

    it('multiple fields can be disabled simultaneously', () => {
      const toml = `
version = 1
[implement]
prompt = "test"
[implement.trigger]
comment = false
status = false
label = "opencara:implement"
`;
      const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
      expect(result.implement!.trigger.comment).toBeUndefined();
      expect(result.implement!.trigger.status).toBeUndefined();
      expect(result.implement!.trigger.label).toBe('opencara:implement');
    });
  });

  describe('custom trigger values', () => {
    it('parses all trigger fields on review', () => {
      const toml = `
version = 1
[review]
prompt = "test"
[review.trigger]
events = ["opened", "synchronize"]
comment = "/review"
label = "opencara:review"
skip = ["draft", "label:wip"]
`;
      const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
      expect(result.review!.trigger.events).toEqual(['opened', 'synchronize']);
      expect(result.review!.trigger.comment).toBe('/review');
      expect(result.review!.trigger.label).toBe('opencara:review');
      expect(result.review!.trigger.skip).toEqual(['draft', 'label:wip']);
    });

    it('adds label trigger to implement', () => {
      const toml = `
version = 1
[implement]
prompt = "test"
[implement.trigger]
label = "opencara:implement"
`;
      const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
      expect(result.implement!.trigger.label).toBe('opencara:implement');
      // Defaults still active
      expect(result.implement!.trigger.comment).toBe('/opencara go');
      expect(result.implement!.trigger.status).toBe('Ready');
    });

    it('adds status trigger to fix', () => {
      const toml = `
version = 1
[fix]
prompt = "test"
[fix.trigger]
status = "Fix Ready"
`;
      const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
      expect(result.fix!.trigger.status).toBe('Fix Ready');
      expect(result.fix!.trigger.comment).toBe('/opencara fix'); // default still active
    });
  });

  describe('backward compatibility', () => {
    it('trigger.on treated as trigger.events (review)', () => {
      const toml = `
version = 1
[review]
prompt = "test"
[review.trigger]
on = ["opened", "synchronize"]
`;
      const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
      expect(result.review!.trigger.events).toEqual(['opened', 'synchronize']);
    });

    it('trigger.on treated as trigger.events (legacy format)', () => {
      const config = parseReviewConfig(
        'version = 1\nprompt = "test"\n[trigger]\non = ["opened", "synchronize"]',
      );
      expect('error' in config).toBe(false);
      if (!('error' in config)) {
        expect(config.trigger.events).toEqual(['opened', 'synchronize']);
      }
    });

    it('triage triggers array converted to trigger.events', () => {
      const toml = `
version = 1
[triage]
prompt = "test"
triggers = ["opened", "edited"]
`;
      const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
      expect(result.triage!.trigger.events).toEqual(['opened', 'edited']);
      expect(result.triage!.trigger.comment).toBe('/opencara triage'); // default still active
    });

    it('triage triggers array ignored when [triage.trigger] section present', () => {
      const toml = `
version = 1
[triage]
prompt = "test"
triggers = ["opened", "edited"]
[triage.trigger]
events = ["labeled"]
`;
      const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
      expect(result.triage!.trigger.events).toEqual(['labeled']);
    });

    it('events takes priority over on when both present', () => {
      const toml = `
version = 1
[review]
prompt = "test"
[review.trigger]
events = ["synchronize"]
on = ["opened"]
`;
      const result = parseOpenCaraConfig(toml) as OpenCaraConfig;
      expect(result.review!.trigger.events).toEqual(['synchronize']);
    });
  });

  describe('helper functions', () => {
    it('isEventTriggerEnabled returns true when events present and non-empty', () => {
      expect(isEventTriggerEnabled({ events: ['opened'] })).toBe(true);
    });

    it('isEventTriggerEnabled returns false when events absent', () => {
      expect(isEventTriggerEnabled({})).toBe(false);
    });

    it('isEventTriggerEnabled returns false when events empty', () => {
      expect(isEventTriggerEnabled({ events: [] })).toBe(false);
    });

    it('isCommentTriggerEnabled returns true when comment present', () => {
      expect(isCommentTriggerEnabled({ comment: '/opencara review' })).toBe(true);
    });

    it('isCommentTriggerEnabled returns false when comment absent', () => {
      expect(isCommentTriggerEnabled({})).toBe(false);
    });

    it('isLabelTriggerEnabled returns true when label present', () => {
      expect(isLabelTriggerEnabled({ label: 'opencara:review' })).toBe(true);
    });

    it('isLabelTriggerEnabled returns false when label absent', () => {
      expect(isLabelTriggerEnabled({})).toBe(false);
    });

    it('isStatusTriggerEnabled returns true when status present', () => {
      expect(isStatusTriggerEnabled({ status: 'Ready' })).toBe(true);
    });

    it('isStatusTriggerEnabled returns false when status absent', () => {
      expect(isStatusTriggerEnabled({})).toBe(false);
    });
  });
});

// ── Named agent definitions ([[implement.agents]]) ──

describe('parseOpenCaraConfig — named agents in implement section', () => {
  it('parses named agents with all fields', () => {
    const result = parseOpenCaraConfig(`
version = 1
[implement]
prompt = "Implement changes"

[[implement.agents]]
id = "security-auditor"
prompt = "Focus on security vulnerabilities."
model = "claude-sonnet-4-5-20250514"
tool = "claude"

[[implement.agents]]
id = "perf-reviewer"
prompt = "Focus on performance."
model = "gpt-4o"
tool = "codex"
`) as OpenCaraConfig;

    expect(result.implement).toBeDefined();
    expect(result.implement!.agents).toBeDefined();
    expect(result.implement!.agents).toHaveLength(2);

    expect(result.implement!.agents![0]).toEqual({
      id: 'security-auditor',
      prompt: 'Focus on security vulnerabilities.',
      model: 'claude-sonnet-4-5-20250514',
      tool: 'claude',
    });
    expect(result.implement!.agents![1]).toEqual({
      id: 'perf-reviewer',
      prompt: 'Focus on performance.',
      model: 'gpt-4o',
      tool: 'codex',
    });
  });

  it('parses named agents with only required fields (id + prompt)', () => {
    const result = parseOpenCaraConfig(`
version = 1
[implement]
prompt = "Implement changes"

[[implement.agents]]
id = "basic-agent"
prompt = "Do the work."
`) as OpenCaraConfig;

    expect(result.implement!.agents).toHaveLength(1);
    expect(result.implement!.agents![0]).toEqual({
      id: 'basic-agent',
      prompt: 'Do the work.',
    });
    // model and tool should be absent, not undefined
    expect('model' in result.implement!.agents![0]).toBe(false);
    expect('tool' in result.implement!.agents![0]).toBe(false);
  });

  it('skips entries missing id', () => {
    const result = parseOpenCaraConfig(`
version = 1
[implement]
prompt = "Implement changes"

[[implement.agents]]
prompt = "No id here"

[[implement.agents]]
id = "valid"
prompt = "Has id"
`) as OpenCaraConfig;

    expect(result.implement!.agents).toHaveLength(1);
    expect(result.implement!.agents![0].id).toBe('valid');
  });

  it('skips entries missing prompt', () => {
    const result = parseOpenCaraConfig(`
version = 1
[implement]
prompt = "Implement changes"

[[implement.agents]]
id = "no-prompt"

[[implement.agents]]
id = "valid"
prompt = "Has prompt"
`) as OpenCaraConfig;

    expect(result.implement!.agents).toHaveLength(1);
    expect(result.implement!.agents![0].id).toBe('valid');
  });

  it('returns undefined agents when all entries are invalid', () => {
    const result = parseOpenCaraConfig(`
version = 1
[implement]
prompt = "Implement changes"

[[implement.agents]]
prompt = "No id"

[[implement.agents]]
id = "no-prompt"
`) as OpenCaraConfig;

    expect(result.implement!.agents).toBeUndefined();
  });

  it('returns undefined agents when agents array is empty', () => {
    const result = parseOpenCaraConfig(`
version = 1
[implement]
prompt = "Implement changes"
`) as OpenCaraConfig;

    expect(result.implement!.agents).toBeUndefined();
  });

  it('handles mixed valid and invalid entries', () => {
    const result = parseOpenCaraConfig(`
version = 1
[implement]
prompt = "Implement changes"

[[implement.agents]]
id = "first"
prompt = "Valid agent"
model = "gpt-4o"

[[implement.agents]]
prompt = "Missing id"

[[implement.agents]]
id = "second"
prompt = "Another valid"
tool = "codex"

[[implement.agents]]
id = "no-prompt-only-id"
`) as OpenCaraConfig;

    expect(result.implement!.agents).toHaveLength(2);
    expect(result.implement!.agents![0]).toEqual({
      id: 'first',
      prompt: 'Valid agent',
      model: 'gpt-4o',
    });
    expect(result.implement!.agents![1]).toEqual({
      id: 'second',
      prompt: 'Another valid',
      tool: 'codex',
    });
  });

  it('ignores non-string model and tool fields', () => {
    const result = parseOpenCaraConfig(`
version = 1
[implement]
prompt = "Implement changes"

[[implement.agents]]
id = "agent1"
prompt = "Test agent"
model = 123
tool = true
`) as OpenCaraConfig;

    expect(result.implement!.agents).toHaveLength(1);
    expect(result.implement!.agents![0]).toEqual({
      id: 'agent1',
      prompt: 'Test agent',
    });
  });
});

// ── Named agent definitions ([[fix.agents]]) ──

describe('parseOpenCaraConfig — named agents in fix section', () => {
  it('parses named agents with all fields', () => {
    const result = parseOpenCaraConfig(`
version = 1
[fix]
prompt = "Fix the review comments."

[[fix.agents]]
id = "security-fixer"
prompt = "Focus on fixing security vulnerabilities."
model = "claude-sonnet-4-5-20250514"
tool = "claude"

[[fix.agents]]
id = "perf-fixer"
prompt = "Focus on fixing performance issues."
model = "gpt-4o"
tool = "codex"
`) as OpenCaraConfig;

    expect(result.fix).toBeDefined();
    expect(result.fix!.agents).toBeDefined();
    expect(result.fix!.agents).toHaveLength(2);

    expect(result.fix!.agents![0]).toEqual({
      id: 'security-fixer',
      prompt: 'Focus on fixing security vulnerabilities.',
      model: 'claude-sonnet-4-5-20250514',
      tool: 'claude',
    });
    expect(result.fix!.agents![1]).toEqual({
      id: 'perf-fixer',
      prompt: 'Focus on fixing performance issues.',
      model: 'gpt-4o',
      tool: 'codex',
    });
  });

  it('parses named agents with only required fields (id + prompt)', () => {
    const result = parseOpenCaraConfig(`
version = 1
[fix]
prompt = "Fix the review comments."

[[fix.agents]]
id = "basic-fixer"
prompt = "Fix the issues."
`) as OpenCaraConfig;

    expect(result.fix!.agents).toHaveLength(1);
    expect(result.fix!.agents![0]).toEqual({
      id: 'basic-fixer',
      prompt: 'Fix the issues.',
    });
    // model and tool should be absent, not undefined
    expect('model' in result.fix!.agents![0]).toBe(false);
    expect('tool' in result.fix!.agents![0]).toBe(false);
  });

  it('skips entries missing id', () => {
    const result = parseOpenCaraConfig(`
version = 1
[fix]
prompt = "Fix the review comments."

[[fix.agents]]
prompt = "No id here"

[[fix.agents]]
id = "valid"
prompt = "Has id"
`) as OpenCaraConfig;

    expect(result.fix!.agents).toHaveLength(1);
    expect(result.fix!.agents![0].id).toBe('valid');
  });

  it('skips entries missing prompt', () => {
    const result = parseOpenCaraConfig(`
version = 1
[fix]
prompt = "Fix the review comments."

[[fix.agents]]
id = "no-prompt"

[[fix.agents]]
id = "valid"
prompt = "Has prompt"
`) as OpenCaraConfig;

    expect(result.fix!.agents).toHaveLength(1);
    expect(result.fix!.agents![0].id).toBe('valid');
  });

  it('returns undefined agents when all entries are invalid', () => {
    const result = parseOpenCaraConfig(`
version = 1
[fix]
prompt = "Fix the review comments."

[[fix.agents]]
prompt = "No id"

[[fix.agents]]
id = "no-prompt"
`) as OpenCaraConfig;

    expect(result.fix!.agents).toBeUndefined();
  });

  it('returns undefined agents when agents array is empty', () => {
    const result = parseOpenCaraConfig(`
version = 1
[fix]
prompt = "Fix the review comments."
`) as OpenCaraConfig;

    expect(result.fix!.agents).toBeUndefined();
  });

  it('handles mixed valid and invalid entries', () => {
    const result = parseOpenCaraConfig(`
version = 1
[fix]
prompt = "Fix the review comments."

[[fix.agents]]
id = "first"
prompt = "Valid fixer"
model = "gpt-4o"

[[fix.agents]]
prompt = "Missing id"

[[fix.agents]]
id = "second"
prompt = "Another valid"
tool = "codex"

[[fix.agents]]
id = "no-prompt-only-id"
`) as OpenCaraConfig;

    expect(result.fix!.agents).toHaveLength(2);
    expect(result.fix!.agents![0]).toEqual({
      id: 'first',
      prompt: 'Valid fixer',
      model: 'gpt-4o',
    });
    expect(result.fix!.agents![1]).toEqual({
      id: 'second',
      prompt: 'Another valid',
      tool: 'codex',
    });
  });
});

// ── agent_field in implement/fix sections ──

describe('parseOpenCaraConfig — agent_field in implement section', () => {
  it('parses agent_field from implement section', () => {
    const result = parseOpenCaraConfig(`
version = 1
[implement]
prompt = "Implement"
agent_field = "Agent"
`) as OpenCaraConfig;

    expect(result.implement!.agent_field).toBe('Agent');
  });

  it('agent_field is undefined when absent', () => {
    const result = parseOpenCaraConfig(`
version = 1
[implement]
prompt = "Implement"
`) as OpenCaraConfig;

    expect(result.implement!.agent_field).toBeUndefined();
    expect('agent_field' in result.implement!).toBe(false);
  });

  it('ignores non-string agent_field', () => {
    const result = parseOpenCaraConfig(`
version = 1
[implement]
prompt = "Implement"
agent_field = 42
`) as OpenCaraConfig;

    expect(result.implement!.agent_field).toBeUndefined();
    expect('agent_field' in result.implement!).toBe(false);
  });

  it('works alongside named agents', () => {
    const result = parseOpenCaraConfig(`
version = 1
[implement]
prompt = "Implement"
agent_field = "Agent"

[[implement.agents]]
id = "security-auditor"
prompt = "Focus on security"
`) as OpenCaraConfig;

    expect(result.implement!.agent_field).toBe('Agent');
    expect(result.implement!.agents).toHaveLength(1);
    expect(result.implement!.agents![0].id).toBe('security-auditor');
  });
});

describe('parseOpenCaraConfig — agent_field in fix section', () => {
  it('parses agent_field from fix section', () => {
    const result = parseOpenCaraConfig(`
version = 1
[fix]
prompt = "Fix"
agent_field = "Agent"
`) as OpenCaraConfig;

    expect(result.fix!.agent_field).toBe('Agent');
  });

  it('agent_field is undefined when absent', () => {
    const result = parseOpenCaraConfig(`
version = 1
[fix]
prompt = "Fix"
`) as OpenCaraConfig;

    expect(result.fix!.agent_field).toBeUndefined();
    expect('agent_field' in result.fix!).toBe(false);
  });

  it('ignores non-string agent_field', () => {
    const result = parseOpenCaraConfig(`
version = 1
[fix]
prompt = "Fix"
agent_field = true
`) as OpenCaraConfig;

    expect(result.fix!.agent_field).toBeUndefined();
    expect('agent_field' in result.fix!).toBe(false);
  });

  it('works alongside named agents', () => {
    const result = parseOpenCaraConfig(`
version = 1
[fix]
prompt = "Fix"
agent_field = "Fixer"

[[fix.agents]]
id = "security-fixer"
prompt = "Fix security issues"
`) as OpenCaraConfig;

    expect(result.fix!.agent_field).toBe('Fixer');
    expect(result.fix!.agents).toHaveLength(1);
    expect(result.fix!.agents![0].id).toBe('security-fixer');
  });
});

describe('resolveNamedAgent', () => {
  const implementConfig: ImplementConfig = {
    enabled: true,
    prompt: 'Implement changes',
    agentCount: 1,
    timeout: '10m',
    preferredModels: [],
    preferredTools: [],
    modelDiversityGraceMs: 30_000,
    trigger: { comment: '/opencara go' },
    agents: [
      { id: 'security-auditor', prompt: 'Security focus', model: 'claude-sonnet-4-5-20250514' },
      { id: 'perf-reviewer', prompt: 'Performance focus', tool: 'codex' },
    ],
  };

  it('finds agent by id', () => {
    const agent = resolveNamedAgent(implementConfig, 'security-auditor');
    expect(agent).toEqual({
      id: 'security-auditor',
      prompt: 'Security focus',
      model: 'claude-sonnet-4-5-20250514',
    });
  });

  it('finds second agent by id', () => {
    const agent = resolveNamedAgent(implementConfig, 'perf-reviewer');
    expect(agent).toEqual({
      id: 'perf-reviewer',
      prompt: 'Performance focus',
      tool: 'codex',
    });
  });

  it('returns undefined for unknown id', () => {
    expect(resolveNamedAgent(implementConfig, 'nonexistent')).toBeUndefined();
  });

  it('returns undefined when agents is undefined', () => {
    const config: ImplementConfig = {
      ...implementConfig,
      agents: undefined,
    };
    expect(resolveNamedAgent(config, 'any')).toBeUndefined();
  });

  it('works with FixConfig', () => {
    const fixConfig: FixConfig = {
      enabled: true,
      prompt: 'Fix the review comments.',
      agentCount: 1,
      timeout: '10m',
      preferredModels: [],
      preferredTools: [],
      modelDiversityGraceMs: 30_000,
      trigger: { comment: '/opencara fix' },
      agents: [
        {
          id: 'security-fixer',
          prompt: 'Fix security issues',
          model: 'claude-sonnet-4-5-20250514',
        },
        { id: 'perf-fixer', prompt: 'Fix performance issues', tool: 'codex' },
      ],
    };
    const agent = resolveNamedAgent(fixConfig, 'security-fixer');
    expect(agent).toEqual({
      id: 'security-fixer',
      prompt: 'Fix security issues',
      model: 'claude-sonnet-4-5-20250514',
    });
    expect(resolveNamedAgent(fixConfig, 'nonexistent')).toBeUndefined();
  });

  it('works with a plain object containing agents', () => {
    const config = {
      agents: [{ id: 'test', prompt: 'Test agent' }],
    };
    expect(resolveNamedAgent(config, 'test')).toEqual({ id: 'test', prompt: 'Test agent' });
  });
});
