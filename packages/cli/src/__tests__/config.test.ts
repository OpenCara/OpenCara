import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import * as fs from 'node:fs';
import {
  loadConfig,
  saveConfig,
  ensureConfigDir,
  resolveAgentLimits,
  resolveCodebaseDir,
  resolveGithubToken,
  RepoConfigError,
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_PLATFORM_URL,
  DEFAULT_MAX_DIFF_SIZE_KB,
} from '../config.js';

describe('config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CONFIG_DIR points to ~/.opencara', () => {
    expect(CONFIG_DIR).toContain('.opencara');
  });

  it('CONFIG_FILE points to config.yml', () => {
    expect(CONFIG_FILE).toContain('config.yml');
  });

  it('DEFAULT_PLATFORM_URL is correct', () => {
    expect(DEFAULT_PLATFORM_URL).toBe('https://api.opencara.dev');
  });

  describe('ensureConfigDir', () => {
    it('creates config directory recursively', () => {
      ensureConfigDir();
      expect(fs.mkdirSync).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true });
    });
  });

  describe('loadConfig', () => {
    it('returns defaults when config file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const config = loadConfig();

      expect(config.apiKey).toBeNull();
      expect(config.platformUrl).toBe(DEFAULT_PLATFORM_URL);
      expect(config.maxDiffSizeKb).toBe(DEFAULT_MAX_DIFF_SIZE_KB);
      expect(config.githubToken).toBeNull();
      expect(config.codebaseDir).toBeNull();
      expect(config.limits).toBeNull();
      expect(config.agentCommand).toBeNull();
    });

    it('parses valid config file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        'api_key: cr_test123\nplatform_url: https://custom.dev\n',
      );

      const config = loadConfig();

      expect(config.apiKey).toBe('cr_test123');
      expect(config.platformUrl).toBe('https://custom.dev');
    });

    it('parses max_diff_size_kb config field', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('max_diff_size_kb: 200\n');

      const config = loadConfig();

      expect(config.maxDiffSizeKb).toBe(200);
    });

    it('returns defaults for non-number max_diff_size_kb', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('max_diff_size_kb: big\n');

      const config = loadConfig();
      expect(config.maxDiffSizeKb).toBe(DEFAULT_MAX_DIFF_SIZE_KB);
    });

    it('silently ignores old anthropic_api_key and review_model fields', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        'anthropic_api_key: sk-ant-test\nreview_model: claude-opus-4-6\napi_key: cr_test\n',
      );

      const config = loadConfig();

      // Old fields are ignored, no errors thrown
      expect(config.apiKey).toBe('cr_test');
      expect(config).not.toHaveProperty('anthropicApiKey');
      expect(config).not.toHaveProperty('reviewModel');
    });

    it('returns defaults for empty config file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('');

      const config = loadConfig();

      expect(config.apiKey).toBeNull();
      expect(config.platformUrl).toBe(DEFAULT_PLATFORM_URL);
    });

    it('returns defaults for config with non-object content', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('just a string');

      const config = loadConfig();

      expect(config.apiKey).toBeNull();
      expect(config.platformUrl).toBe(DEFAULT_PLATFORM_URL);
    });

    it('handles config with missing fields', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('some_other: value\n');

      const config = loadConfig();

      expect(config.apiKey).toBeNull();
      expect(config.platformUrl).toBe(DEFAULT_PLATFORM_URL);
    });

    it('handles config with non-string api_key', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('api_key: 123\n');

      const config = loadConfig();

      expect(config.apiKey).toBeNull();
    });

    it('handles config with non-string platform_url', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('platform_url: 123\n');

      const config = loadConfig();

      expect(config.platformUrl).toBe(DEFAULT_PLATFORM_URL);
    });

    it('parses consumption limits', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        'limits:\n  tokens_per_day: 50000\n  tokens_per_month: 500000\n  reviews_per_day: 20\n',
      );

      const config = loadConfig();

      expect(config.limits).toEqual({
        tokens_per_day: 50000,
        tokens_per_month: 500000,
        reviews_per_day: 20,
      });
    });

    it('parses partial limits (only tokens_per_day)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('limits:\n  tokens_per_day: 50000\n');

      const config = loadConfig();

      expect(config.limits).toEqual({ tokens_per_day: 50000 });
    });

    it('returns null limits when limits section is not an object', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('limits: not_an_object\n');

      const config = loadConfig();

      expect(config.limits).toBeNull();
    });

    it('returns null limits when limits section has no valid numeric fields', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        'limits:\n  tokens_per_day: not_a_number\n  unknown_field: 123\n',
      );

      const config = loadConfig();

      expect(config.limits).toBeNull();
    });

    it('ignores non-numeric limit values', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        'limits:\n  tokens_per_day: 50000\n  reviews_per_day: bad\n',
      );

      const config = loadConfig();

      expect(config.limits).toEqual({ tokens_per_day: 50000 });
    });

    it('returns null limits when limits section is missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('api_key: cr_test\n');

      const config = loadConfig();

      expect(config.limits).toBeNull();
    });

    it('parses agent_command config field', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('agent_command: "ollama run codestral"\n');

      const config = loadConfig();

      expect(config.agentCommand).toBe('ollama run codestral');
    });

    it('returns null agentCommand for non-string values', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('agent_command: 123\n');

      const config = loadConfig();

      expect(config.agentCommand).toBeNull();
    });

    it('returns null agentCommand when not present', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('api_key: cr_test\n');

      const config = loadConfig();

      expect(config.agentCommand).toBeNull();
    });
  });

  describe('saveConfig', () => {
    const baseConfig = {
      apiKey: null as string | null,
      platformUrl: 'https://api.dev',
      maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
      githubToken: null as string | null,
      codebaseDir: null as string | null,
      limits: null as import('../config.js').ConsumptionLimits | null,
      agentCommand: null as string | null,
      agents: null as import('../config.js').LocalAgentConfig[] | null,
    };

    it('saves config with API key', () => {
      saveConfig({ ...baseConfig, apiKey: 'cr_test' });

      expect(fs.mkdirSync).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        CONFIG_FILE,
        expect.stringContaining('api_key: cr_test'),
        { encoding: 'utf-8', mode: 0o600 },
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        CONFIG_FILE,
        expect.stringContaining('platform_url: https://api.dev'),
        { encoding: 'utf-8', mode: 0o600 },
      );
    });

    it('saves config without API key when null', () => {
      saveConfig(baseConfig);

      expect(fs.writeFileSync).toHaveBeenCalled();
      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).not.toContain('api_key');
      expect(content).toContain('platform_url');
    });

    it('does not save anthropic_api_key or review_model', () => {
      saveConfig(baseConfig);

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).not.toContain('anthropic_api_key');
      expect(content).not.toContain('review_model');
    });

    it('saves max_diff_size_kb when non-default', () => {
      saveConfig({ ...baseConfig, maxDiffSizeKb: 200 });

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).toContain('max_diff_size_kb: 200');
    });

    it('does not save max_diff_size_kb when default', () => {
      saveConfig(baseConfig);

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).not.toContain('max_diff_size_kb');
    });

    it('saves limits when present', () => {
      saveConfig({
        ...baseConfig,
        limits: { tokens_per_day: 50000, reviews_per_day: 20 },
      });

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).toContain('limits');
      expect(content).toContain('tokens_per_day: 50000');
      expect(content).toContain('reviews_per_day: 20');
    });

    it('does not save limits when null', () => {
      saveConfig(baseConfig);

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).not.toContain('limits');
    });

    it('saves agent_command when present', () => {
      saveConfig({ ...baseConfig, agentCommand: 'ollama run codestral' });

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).toContain('agent_command: ollama run codestral');
    });

    it('does not save agent_command when null', () => {
      saveConfig(baseConfig);

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).not.toContain('agent_command');
    });
  });

  describe('agents parsing', () => {
    it('returns null when agents key is absent', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('api_key: cr_test\n');

      const config = loadConfig();
      expect(config.agents).toBeNull();
    });

    it('returns empty array when agents key is present but empty', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('api_key: cr_test\nagents: []\n');

      const config = loadConfig();
      expect(config.agents).toEqual([]);
    });

    it('parses agents with model, tool, and command', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        'api_key: cr_test\nagents:\n  - model: claude-opus-4-6\n    tool: claude-code\n    command: claude -p\n',
      );

      const config = loadConfig();
      expect(config.agents).toEqual([
        { model: 'claude-opus-4-6', tool: 'claude-code', command: 'claude -p' },
      ]);
    });

    it('parses agents without command field', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        'api_key: cr_test\nagents:\n  - model: glm-5\n    tool: qwen\n',
      );

      const config = loadConfig();
      expect(config.agents).toEqual([{ model: 'glm-5', tool: 'qwen' }]);
    });

    it('skips invalid entries and warns', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        'api_key: cr_test\nagents:\n  - model: valid\n    tool: ok\n  - broken: true\n',
      );

      const config = loadConfig();
      expect(config.agents).toEqual([{ model: 'valid', tool: 'ok' }]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('agents[1]'));
      warnSpy.mockRestore();
    });

    it('saveConfig writes agents when not null', () => {
      saveConfig({
        apiKey: 'cr_test',
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        githubToken: null,
        codebaseDir: null,
        limits: null,
        agentCommand: null,
        agents: [{ model: 'glm-5', tool: 'qwen', command: 'qwen -y -m glm-5' }],
      });

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('agents');
      expect(written).toContain('glm-5');
    });

    it('saveConfig omits agents when null', () => {
      saveConfig({
        apiKey: 'cr_test',
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        githubToken: null,
        codebaseDir: null,
        limits: null,
        agentCommand: null,
        agents: null,
      });

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).not.toContain('agents');
    });
  });

  describe('resolveAgentLimits', () => {
    it('returns null when both are null/undefined', () => {
      expect(resolveAgentLimits(undefined, null)).toBeNull();
    });

    it('returns global limits when agent has none', () => {
      const global = { tokens_per_day: 100000, reviews_per_day: 50 };
      expect(resolveAgentLimits(undefined, global)).toEqual(global);
    });

    it('returns agent limits when global is null', () => {
      const agent = { tokens_per_day: 30000 };
      expect(resolveAgentLimits(agent, null)).toEqual(agent);
    });

    it('agent limits override global, missing fields fall back', () => {
      const global = { tokens_per_day: 100000, tokens_per_month: 2000000, reviews_per_day: 50 };
      const agent = { tokens_per_day: 30000 };
      expect(resolveAgentLimits(agent, global)).toEqual({
        tokens_per_day: 30000,
        tokens_per_month: 2000000,
        reviews_per_day: 50,
      });
    });

    it('agent fully overrides all global fields', () => {
      const global = { tokens_per_day: 100000, reviews_per_day: 50 };
      const agent = { tokens_per_day: 10000, reviews_per_day: 5 };
      expect(resolveAgentLimits(agent, global)).toEqual({
        tokens_per_day: 10000,
        reviews_per_day: 5,
      });
    });
  });

  describe('agent name parsing', () => {
    it('parses name from agent entries', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - name: SecurityBot
    model: claude-sonnet-4-6
    tool: claude-code
  - model: glm-5
    tool: qwen
`);
      const config = loadConfig();
      expect(config.agents).toHaveLength(2);
      expect(config.agents![0].name).toBe('SecurityBot');
      expect(config.agents![1].name).toBeUndefined();
    });

    it('round-trips name through save and load', () => {
      saveConfig({
        apiKey: 'cr_test',
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        githubToken: null,
        codebaseDir: null,
        limits: null,
        agentCommand: null,
        agents: [{ model: 'claude-sonnet-4-6', tool: 'claude-code', name: 'MyBot' }],
      });

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('name: MyBot');
    });
  });

  describe('agent review_only config', () => {
    it('parses review_only: true from agent entries', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: gpt-5-codex
    tool: codex
    review_only: true
  - model: claude-sonnet-4-6
    tool: claude-code
`);
      const config = loadConfig();
      expect(config.agents).toHaveLength(2);
      expect(config.agents![0].review_only).toBe(true);
      expect(config.agents![1].review_only).toBeUndefined();
    });

    it('ignores review_only: false', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-sonnet-4-6
    tool: claude-code
    review_only: false
`);
      const config = loadConfig();
      expect(config.agents![0].review_only).toBeUndefined();
    });
  });

  describe('agent router config', () => {
    it('parses router: true from agent entries', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-sonnet-4-6
    tool: claude-code
    router: true
  - model: glm-5
    tool: qwen
`);
      const config = loadConfig();
      expect(config.agents).toHaveLength(2);
      expect(config.agents![0].router).toBe(true);
      expect(config.agents![1].router).toBeUndefined();
    });

    it('ignores router: false', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-sonnet-4-6
    tool: claude-code
    router: false
`);
      const config = loadConfig();
      expect(config.agents![0].router).toBeUndefined();
    });
  });

  describe('per-agent limits in config', () => {
    it('parses per-agent limits from YAML', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
    limits:
      tokens_per_day: 30000
      reviews_per_day: 10
  - model: glm-5
    tool: qwen
`);
      const config = loadConfig();
      expect(config.agents).toHaveLength(2);
      expect(config.agents![0].limits).toEqual({
        tokens_per_day: 30000,
        reviews_per_day: 10,
      });
      expect(config.agents![1].limits).toBeUndefined();
    });
  });

  describe('repo config parsing', () => {
    it('defaults to undefined repos when omitted', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
`);
      const config = loadConfig();
      expect(config.agents![0].repos).toBeUndefined();
    });

    it('parses repos with mode: all', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
    repos:
      mode: all
`);
      const config = loadConfig();
      expect(config.agents![0].repos).toEqual({ mode: 'all' });
    });

    it('parses repos with mode: own', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
    repos:
      mode: own
`);
      const config = loadConfig();
      expect(config.agents![0].repos).toEqual({ mode: 'own' });
    });

    it('parses repos with mode: whitelist and list', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
    repos:
      mode: whitelist
      list:
        - OpenCara/OpenCara
        - myorg/my-project
`);
      const config = loadConfig();
      expect(config.agents![0].repos).toEqual({
        mode: 'whitelist',
        list: ['OpenCara/OpenCara', 'myorg/my-project'],
      });
    });

    it('parses repos with mode: blacklist and list', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
    repos:
      mode: blacklist
      list:
        - spam-org/spam-repo
`);
      const config = loadConfig();
      expect(config.agents![0].repos).toEqual({
        mode: 'blacklist',
        list: ['spam-org/spam-repo'],
      });
    });

    it('throws RepoConfigError for invalid mode', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
    repos:
      mode: invalid
`);
      expect(() => loadConfig()).toThrow(RepoConfigError);
      expect(() => loadConfig()).toThrow('must be one of: all, own, whitelist, blacklist');
    });

    it('throws RepoConfigError when mode is missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
    repos:
      list:
        - foo/bar
`);
      expect(() => loadConfig()).toThrow(RepoConfigError);
      expect(() => loadConfig()).toThrow('mode is required');
    });

    it('throws RepoConfigError when repos is not an object', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
    repos: just-a-string
`);
      expect(() => loadConfig()).toThrow(RepoConfigError);
      expect(() => loadConfig()).toThrow('must be an object');
    });

    it('throws RepoConfigError when whitelist has no list', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
    repos:
      mode: whitelist
`);
      expect(() => loadConfig()).toThrow(RepoConfigError);
      expect(() => loadConfig()).toThrow('list is required and must be non-empty');
    });

    it('throws RepoConfigError when blacklist has empty list', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
    repos:
      mode: blacklist
      list: []
`);
      expect(() => loadConfig()).toThrow(RepoConfigError);
      expect(() => loadConfig()).toThrow('list is required and must be non-empty');
    });

    it('throws RepoConfigError for invalid owner/repo format', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
    repos:
      mode: whitelist
      list:
        - invalid-format
`);
      expect(() => loadConfig()).toThrow(RepoConfigError);
      expect(() => loadConfig()).toThrow("must match 'owner/repo' format");
    });

    it('throws RepoConfigError for list entry with multiple slashes', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
    repos:
      mode: whitelist
      list:
        - org/repo/extra
`);
      expect(() => loadConfig()).toThrow(RepoConfigError);
      expect(() => loadConfig()).toThrow("must match 'owner/repo' format");
    });

    it('does not require list for mode: all', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
    repos:
      mode: all
`);
      const config = loadConfig();
      expect(config.agents![0].repos).toEqual({ mode: 'all' });
      expect(config.agents![0].repos!.list).toBeUndefined();
    });

    it('does not require list for mode: own', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
    repos:
      mode: own
`);
      const config = loadConfig();
      expect(config.agents![0].repos).toEqual({ mode: 'own' });
      expect(config.agents![0].repos!.list).toBeUndefined();
    });

    it('saveConfig persists repos field on agents', () => {
      saveConfig({
        apiKey: 'cr_test',
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        githubToken: null,
        codebaseDir: null,
        limits: null,
        agentCommand: null,
        agents: [
          {
            model: 'claude-opus-4-6',
            tool: 'claude-code',
            repos: { mode: 'whitelist', list: ['org/repo'] },
          },
        ],
      });

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('repos');
      expect(written).toContain('whitelist');
      expect(written).toContain('org/repo');
    });
  });

  describe('github_token config', () => {
    it('parses global github_token', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('github_token: ghp_abc123\n');

      const config = loadConfig();
      expect(config.githubToken).toBe('ghp_abc123');
    });

    it('returns null for non-string github_token', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('github_token: 123\n');

      const config = loadConfig();
      expect(config.githubToken).toBeNull();
    });

    it('returns null when github_token is absent', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('api_key: cr_test\n');

      const config = loadConfig();
      expect(config.githubToken).toBeNull();
    });

    it('saveConfig writes github_token when present', () => {
      saveConfig({
        apiKey: null,
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        githubToken: 'ghp_xyz789',
        codebaseDir: null,
        limits: null,
        agentCommand: null,
        agents: null,
      });

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).toContain('github_token: ghp_xyz789');
    });

    it('saveConfig omits github_token when null', () => {
      saveConfig({
        apiKey: null,
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        githubToken: null,
        codebaseDir: null,
        limits: null,
        agentCommand: null,
        agents: null,
      });

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).not.toContain('github_token');
    });

    it('parses per-agent github_token', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
    github_token: ghp_agent1
  - model: glm-5
    tool: qwen
`);
      const config = loadConfig();
      expect(config.agents![0].github_token).toBe('ghp_agent1');
      expect(config.agents![1].github_token).toBeUndefined();
    });
  });

  describe('resolveGithubToken', () => {
    it('returns null when both are null/undefined', () => {
      expect(resolveGithubToken(undefined, null)).toBeNull();
    });

    it('returns global token when agent has none', () => {
      expect(resolveGithubToken(undefined, 'ghp_global')).toBe('ghp_global');
    });

    it('returns agent token when global is null', () => {
      expect(resolveGithubToken('ghp_agent', null)).toBe('ghp_agent');
    });

    it('agent token overrides global', () => {
      expect(resolveGithubToken('ghp_agent', 'ghp_global')).toBe('ghp_agent');
    });

    it('empty agent token falls back to global', () => {
      expect(resolveGithubToken('', 'ghp_global')).toBe('ghp_global');
    });
  });

  describe('loadConfig ignores anonymous_agents', () => {
    it('does not include anonymousAgents in config', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
anonymous_agents:
  - agent_id: "a1b2c3d4"
    api_key: "cr_abc123"
    model: "claude-sonnet-4-6"
    tool: "claude"
`);
      const config = loadConfig();
      expect(config).not.toHaveProperty('anonymousAgents');
    });
  });

  describe('codebase_dir config', () => {
    it('parses global codebase_dir', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('codebase_dir: ~/.opencara/repos\n');

      const config = loadConfig();
      expect(config.codebaseDir).toBe('~/.opencara/repos');
    });

    it('returns null for non-string codebase_dir', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('codebase_dir: 123\n');

      const config = loadConfig();
      expect(config.codebaseDir).toBeNull();
    });

    it('returns null when codebase_dir is absent', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('api_key: cr_test\n');

      const config = loadConfig();
      expect(config.codebaseDir).toBeNull();
    });

    it('saveConfig writes codebase_dir when present', () => {
      saveConfig({
        apiKey: null,
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        githubToken: null,
        codebaseDir: '~/.opencara/repos',
        limits: null,
        agentCommand: null,
        agents: null,
      });

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).toContain('codebase_dir: ~/.opencara/repos');
    });

    it('saveConfig omits codebase_dir when null', () => {
      saveConfig({
        apiKey: null,
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        githubToken: null,
        codebaseDir: null,
        limits: null,
        agentCommand: null,
        agents: null,
      });

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).not.toContain('codebase_dir');
    });

    it('parses per-agent codebase_dir', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
    codebase_dir: ~/repos
  - model: glm-5
    tool: qwen
`);
      const config = loadConfig();
      expect(config.agents![0].codebase_dir).toBe('~/repos');
      expect(config.agents![1].codebase_dir).toBeUndefined();
    });
  });

  describe('resolveCodebaseDir', () => {
    it('returns null when both are null/undefined', () => {
      expect(resolveCodebaseDir(undefined, null)).toBeNull();
    });

    it('returns global dir when agent has none', () => {
      const result = resolveCodebaseDir(undefined, '/tmp/repos');
      expect(result).toBe('/tmp/repos');
    });

    it('returns agent dir when global is null', () => {
      const result = resolveCodebaseDir('/tmp/agent-repos', null);
      expect(result).toBe('/tmp/agent-repos');
    });

    it('agent dir overrides global', () => {
      const result = resolveCodebaseDir('/tmp/agent', '/tmp/global');
      expect(result).toBe('/tmp/agent');
    });

    it('expands ~ to home directory', () => {
      const result = resolveCodebaseDir(undefined, '~/repos');
      expect(result).not.toContain('~');
      expect(result).toContain('repos');
    });

    it('expands ~ alone to home directory', () => {
      const result = resolveCodebaseDir('~', null);
      expect(result).not.toContain('~');
    });

    it('returns null for empty string agent dir with null global', () => {
      expect(resolveCodebaseDir('', null)).toBeNull();
    });
  });
});
