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
  requireApiKey,
  resolveAgentLimits,
  findAnonymousAgent,
  removeAnonymousAgent,
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
      limits: null as import('../config.js').ConsumptionLimits | null,
      agentCommand: null as string | null,
      agents: null as import('../config.js').LocalAgentConfig[] | null,
      anonymousAgents: [] as import('../config.js').AnonymousAgentEntry[],
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

  describe('requireApiKey', () => {
    it('returns API key when present', () => {
      const key = requireApiKey({
        apiKey: 'cr_test',
        platformUrl: 'test',
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        limits: null,
        agentCommand: null,
        agents: null,
        anonymousAgents: [],
      });
      expect(key).toBe('cr_test');
    });

    it('exits when API key is missing', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() =>
        requireApiKey({
          apiKey: null,
          platformUrl: 'test',
          maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
          limits: null,
          agentCommand: null,
          agents: null,
          anonymousAgents: [],
        }),
      ).toThrow('process.exit');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Not authenticated'));

      exitSpy.mockRestore();
      errorSpy.mockRestore();
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
        limits: null,
        agentCommand: null,
        agents: [{ model: 'glm-5', tool: 'qwen', command: 'qwen -y -m glm-5' }],
        anonymousAgents: [],
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
        limits: null,
        agentCommand: null,
        agents: null,
        anonymousAgents: [],
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
        limits: null,
        agentCommand: null,
        agents: [{ model: 'claude-sonnet-4-6', tool: 'claude-code', name: 'MyBot' }],
        anonymousAgents: [],
      });

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('name: MyBot');
    });

    it('parses name from anonymous agent entries', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
anonymous_agents:
  - agent_id: "a1b2"
    api_key: "cr_key"
    model: "claude-sonnet-4-6"
    tool: "claude"
    name: "AnonBot"
`);
      const config = loadConfig();
      expect(config.anonymousAgents[0].name).toBe('AnonBot');
    });

    it('saves name on anonymous agents', () => {
      saveConfig({
        apiKey: null,
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        limits: null,
        agentCommand: null,
        agents: null,
        anonymousAgents: [
          {
            agentId: 'a1',
            apiKey: 'cr_key',
            model: 'claude-sonnet-4-6',
            tool: 'claude',
            name: 'AnonBot',
          },
        ],
      });

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('name: AnonBot');
    });

    it('omits name on anonymous agents when not set', () => {
      saveConfig({
        apiKey: null,
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        limits: null,
        agentCommand: null,
        agents: null,
        anonymousAgents: [
          { agentId: 'a1', apiKey: 'cr_key', model: 'claude-sonnet-4-6', tool: 'claude' },
        ],
      });

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      // Should not contain 'name:' as a key for anonymous agents
      // But it does contain the section keys. Let's check no 'name' key in the anonymous_agents section
      const lines = written.split('\n');
      const anonSection = lines.slice(lines.findIndex((l) => l.includes('anonymous_agents')));
      expect(anonSection.some((l) => l.trim().startsWith('name:'))).toBe(false);
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
        limits: null,
        agentCommand: null,
        agents: [
          {
            model: 'claude-opus-4-6',
            tool: 'claude-code',
            repos: { mode: 'whitelist', list: ['org/repo'] },
          },
        ],
        anonymousAgents: [],
      });

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('repos');
      expect(written).toContain('whitelist');
      expect(written).toContain('org/repo');
    });
  });

  describe('anonymous agents', () => {
    it('returns empty array when anonymous_agents key is absent', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('api_key: cr_test\n');

      const config = loadConfig();
      expect(config.anonymousAgents).toEqual([]);
    });

    it('parses anonymous_agents from YAML', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
anonymous_agents:
  - agent_id: "a1b2c3d4"
    api_key: "cr_abc123"
    model: "claude-sonnet-4-6"
    tool: "claude"
`);
      const config = loadConfig();
      expect(config.anonymousAgents).toEqual([
        {
          agentId: 'a1b2c3d4',
          apiKey: 'cr_abc123',
          model: 'claude-sonnet-4-6',
          tool: 'claude',
        },
      ]);
    });

    it('parses anonymous_agents with repo_config', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
anonymous_agents:
  - agent_id: "a1b2c3d4"
    api_key: "cr_abc123"
    model: "claude-sonnet-4-6"
    tool: "claude"
    repo_config:
      mode: whitelist
      list:
        - org/repo
`);
      const config = loadConfig();
      expect(config.anonymousAgents[0].repoConfig).toEqual({
        mode: 'whitelist',
        list: ['org/repo'],
      });
    });

    it('skips invalid anonymous agent entries and warns', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
anonymous_agents:
  - agent_id: "valid"
    api_key: "cr_key"
    model: "m"
    tool: "t"
  - broken: true
`);
      const config = loadConfig();
      expect(config.anonymousAgents).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('anonymous_agents[1]'));
      warnSpy.mockRestore();
    });

    it('saveConfig writes anonymous_agents when non-empty', () => {
      saveConfig({
        apiKey: null,
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        limits: null,
        agentCommand: null,
        agents: null,
        anonymousAgents: [
          { agentId: 'a1', apiKey: 'cr_key', model: 'claude-sonnet-4-6', tool: 'claude' },
        ],
      });

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('anonymous_agents');
      expect(written).toContain('agent_id: a1');
      expect(written).toContain('api_key: cr_key');
    });

    it('saveConfig omits anonymous_agents when empty', () => {
      saveConfig({
        apiKey: null,
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        limits: null,
        agentCommand: null,
        agents: null,
        anonymousAgents: [],
      });

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).not.toContain('anonymous_agents');
    });

    it('saveConfig writes repo_config on anonymous agents', () => {
      saveConfig({
        apiKey: null,
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        limits: null,
        agentCommand: null,
        agents: null,
        anonymousAgents: [
          {
            agentId: 'a1',
            apiKey: 'cr_key',
            model: 'claude-sonnet-4-6',
            tool: 'claude',
            repoConfig: { mode: 'whitelist', list: ['org/repo'] },
          },
        ],
      });

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('repo_config');
      expect(written).toContain('whitelist');
    });
  });

  describe('findAnonymousAgent', () => {
    it('returns matching anonymous agent', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
anonymous_agents:
  - agent_id: "a1b2"
    api_key: "cr_key"
    model: "m"
    tool: "t"
`);
      const config = loadConfig();
      const found = findAnonymousAgent(config, 'a1b2');
      expect(found).not.toBeNull();
      expect(found!.agentId).toBe('a1b2');
    });

    it('returns null when not found', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('');
      const config = loadConfig();
      expect(findAnonymousAgent(config, 'nonexistent')).toBeNull();
    });
  });

  describe('removeAnonymousAgent', () => {
    it('removes matching anonymous agent', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
anonymous_agents:
  - agent_id: "a1"
    api_key: "cr_k1"
    model: "m1"
    tool: "t1"
  - agent_id: "a2"
    api_key: "cr_k2"
    model: "m2"
    tool: "t2"
`);
      const config = loadConfig();
      expect(config.anonymousAgents).toHaveLength(2);

      removeAnonymousAgent(config, 'a1');
      expect(config.anonymousAgents).toHaveLength(1);
      expect(config.anonymousAgents[0].agentId).toBe('a2');
    });

    it('no-op when agent not found', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
anonymous_agents:
  - agent_id: "a1"
    api_key: "cr_k1"
    model: "m1"
    tool: "t1"
`);
      const config = loadConfig();
      removeAnonymousAgent(config, 'nonexistent');
      expect(config.anonymousAgents).toHaveLength(1);
    });
  });
});
