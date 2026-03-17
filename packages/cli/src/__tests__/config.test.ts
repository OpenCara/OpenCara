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
});
