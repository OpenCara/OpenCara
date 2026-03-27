import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  resolveCodebaseDir,
  RepoConfigError,
  ConfigValidationError,
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_PLATFORM_URL,
  DEFAULT_MAX_DIFF_SIZE_KB,
  DEFAULT_MAX_CONSECUTIVE_ERRORS,
} from '../config.js';

describe('config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CONFIG_DIR points to ~/.opencara', () => {
    expect(CONFIG_DIR).toContain('.opencara');
  });

  it('CONFIG_FILE points to config.toml', () => {
    expect(CONFIG_FILE).toContain('config.toml');
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

      expect(config.platformUrl).toBe(DEFAULT_PLATFORM_URL);
      expect(config.maxDiffSizeKb).toBe(DEFAULT_MAX_DIFF_SIZE_KB);
      expect(config.maxConsecutiveErrors).toBe(DEFAULT_MAX_CONSECUTIVE_ERRORS);
      expect(config.codebaseDir).toBeNull();
      expect(config.agentCommand).toBeNull();
    });

    it('warns when config.yml exists but config.toml does not', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        if (s.endsWith('config.toml')) return false;
        if (s.endsWith('config.yml')) return true;
        return false;
      });

      const config = loadConfig();

      expect(config.platformUrl).toBe(DEFAULT_PLATFORM_URL);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Found config.yml but config.toml expected'),
      );
      warnSpy.mockRestore();
    });

    it('does not warn about config.yml when config.toml exists', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('platform_url = "https://custom.dev"\n');

      loadConfig();

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Found config.yml but config.toml expected'),
      );
      warnSpy.mockRestore();
    });

    it('does not warn when neither config.yml nor config.toml exist', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fs.existsSync).mockReturnValue(false);

      loadConfig();

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Found config.yml'));
      warnSpy.mockRestore();
    });

    it('parses valid config file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('platform_url = "https://custom.dev"\n');

      const config = loadConfig();

      expect(config.platformUrl).toBe('https://custom.dev');
    });

    it('parses max_diff_size_kb config field', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('max_diff_size_kb = 200\n');

      const config = loadConfig();

      expect(config.maxDiffSizeKb).toBe(200);
    });

    it('parses max_consecutive_errors config field', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('max_consecutive_errors = 5\n');

      const config = loadConfig();

      expect(config.maxConsecutiveErrors).toBe(5);
    });

    it('returns default for non-number max_consecutive_errors', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('max_consecutive_errors = "many"\n');

      const config = loadConfig();
      expect(config.maxConsecutiveErrors).toBe(DEFAULT_MAX_CONSECUTIVE_ERRORS);
    });

    it('returns defaults for non-number max_diff_size_kb', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('max_diff_size_kb = "big"\n');

      const config = loadConfig();
      expect(config.maxDiffSizeKb).toBe(DEFAULT_MAX_DIFF_SIZE_KB);
    });

    it('silently ignores old anthropic_api_key and review_model fields, but parses api_key', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        'anthropic_api_key = "sk-ant-test"\nreview_model = "claude-opus-4-6"\napi_key = "cr_test"\n',
      );

      const config = loadConfig();

      // Old fields are ignored, no errors thrown
      expect(config).not.toHaveProperty('anthropicApiKey');
      expect(config).not.toHaveProperty('reviewModel');
      // api_key is now a valid config field
      expect(config.apiKey).toBe('cr_test');
    });

    it('returns defaults for empty config file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('');

      const config = loadConfig();

      expect(config.platformUrl).toBe(DEFAULT_PLATFORM_URL);
    });

    it('returns defaults for config with non-object content', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('just a string');

      const config = loadConfig();

      expect(config.platformUrl).toBe(DEFAULT_PLATFORM_URL);
    });

    it('handles config with missing fields', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('some_other = "value"\n');

      const config = loadConfig();

      expect(config.platformUrl).toBe(DEFAULT_PLATFORM_URL);
    });

    it('handles config with non-string platform_url', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('platform_url = 123\n');

      const config = loadConfig();

      expect(config.platformUrl).toBe(DEFAULT_PLATFORM_URL);
    });

    it('parses agent_command config field', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('agent_command = "ollama run codestral"\n');

      const config = loadConfig();

      expect(config.agentCommand).toBe('ollama run codestral');
    });

    it('returns null agentCommand for non-string values', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('agent_command = 123\n');

      const config = loadConfig();

      expect(config.agentCommand).toBeNull();
    });

    it('returns null agentCommand when not present', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('api_key = "cr_test"\n');

      const config = loadConfig();

      expect(config.agentCommand).toBeNull();
    });

    describe('OPENCARA_PLATFORM_URL env var', () => {
      const ENV_KEY = 'OPENCARA_PLATFORM_URL';

      afterEach(() => {
        delete process.env[ENV_KEY];
      });

      it('env var overrides config file value', () => {
        process.env[ENV_KEY] = 'https://env-override.dev';
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url = "https://from-config.dev"\n');

        const config = loadConfig();

        expect(config.platformUrl).toBe('https://env-override.dev');
      });

      it('env var overrides default when no config file exists', () => {
        process.env[ENV_KEY] = 'https://env-override.dev';
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const config = loadConfig();

        expect(config.platformUrl).toBe('https://env-override.dev');
      });

      it('config file value used when env var is not set', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url = "https://from-config.dev"\n');

        const config = loadConfig();

        expect(config.platformUrl).toBe('https://from-config.dev');
      });

      it('default used when neither env var nor config file is set', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const config = loadConfig();

        expect(config.platformUrl).toBe(DEFAULT_PLATFORM_URL);
      });

      it('empty env var falls back to config file', () => {
        process.env[ENV_KEY] = '';
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url = "https://from-config.dev"\n');

        const config = loadConfig();

        expect(config.platformUrl).toBe('https://from-config.dev');
      });

      it('whitespace-only env var falls back to config file', () => {
        process.env[ENV_KEY] = '   ';
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url = "https://from-config.dev"\n');

        const config = loadConfig();

        expect(config.platformUrl).toBe('https://from-config.dev');
      });
    });
  });

  describe('saveConfig', () => {
    const baseConfig = {
      platformUrl: 'https://api.dev',
      apiKey: null as string | null,
      maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
      maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
      codebaseDir: null as string | null,

      agentCommand: null as string | null,
      agents: null as import('../config.js').LocalAgentConfig[] | null,
    };

    it('saves config with platform_url', () => {
      saveConfig(baseConfig);

      expect(fs.mkdirSync).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        CONFIG_FILE,
        expect.stringContaining('platform_url = "https://api.dev"'),
        { encoding: 'utf-8', mode: 0o600 },
      );
    });

    it('does not save api_key when null, and never saves anthropic_api_key or review_model', () => {
      saveConfig(baseConfig);

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).not.toContain('api_key');
      expect(content).not.toContain('anthropic_api_key');
      expect(content).not.toContain('review_model');
    });

    it('saves api_key when set', () => {
      saveConfig({ ...baseConfig, apiKey: 'cr_my_key' });

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).toContain('api_key = "cr_my_key"');
    });

    it('saves max_diff_size_kb when non-default', () => {
      saveConfig({ ...baseConfig, maxDiffSizeKb: 200 });

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).toContain('max_diff_size_kb = 200');
    });

    it('does not save max_diff_size_kb when default', () => {
      saveConfig(baseConfig);

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).not.toContain('max_diff_size_kb');
    });

    it('saves max_consecutive_errors when non-default', () => {
      saveConfig({ ...baseConfig, maxConsecutiveErrors: 5 });

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).toContain('max_consecutive_errors = 5');
    });

    it('does not save max_consecutive_errors when default', () => {
      saveConfig(baseConfig);

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).not.toContain('max_consecutive_errors');
    });

    it('saves agent_command when present', () => {
      saveConfig({ ...baseConfig, agentCommand: 'ollama run codestral' });

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).toContain('agent_command = "ollama run codestral"');
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
      vi.mocked(fs.readFileSync).mockReturnValue('api_key = "cr_test"\n');

      const config = loadConfig();
      expect(config.agents).toBeNull();
    });

    it('returns empty array when agents key is present but empty', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('api_key = "cr_test"\nagents = []\n');

      const config = loadConfig();
      expect(config.agents).toEqual([]);
    });

    it('parses agents with model, tool, and command', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        'api_key = "cr_test"\n[[agents]]\nmodel = "claude-opus-4-6"\ntool = "claude"\ncommand = "claude -p"\n',
      );

      const config = loadConfig();
      expect(config.agents).toEqual([
        { model: 'claude-opus-4-6', tool: 'claude', command: 'claude -p' },
      ]);
    });

    it('parses agents without command field', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        'api_key = "cr_test"\n[[agents]]\nmodel = "glm-5"\ntool = "qwen"\n',
      );

      const config = loadConfig();
      expect(config.agents).toEqual([{ model: 'glm-5', tool: 'qwen' }]);
    });

    it('parses agents with thinking field as string', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        '[[agents]]\nmodel = "claude-sonnet-4-6"\ntool = "claude"\nthinking = "10000"\n',
      );

      const config = loadConfig();
      expect(config.agents).toEqual([
        { model: 'claude-sonnet-4-6', tool: 'claude', thinking: '10000' },
      ]);
    });

    it('parses agents with thinking field as number (converts to string)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        '[[agents]]\nmodel = "claude-sonnet-4-6"\ntool = "claude"\nthinking = 10000\n',
      );

      const config = loadConfig();
      expect(config.agents).toEqual([
        { model: 'claude-sonnet-4-6', tool: 'claude', thinking: '10000' },
      ]);
    });

    it('parses agents with named thinking level', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        '[[agents]]\nmodel = "claude-sonnet-4-6"\ntool = "claude"\nthinking = "high"\n',
      );

      const config = loadConfig();
      expect(config.agents).toEqual([
        { model: 'claude-sonnet-4-6', tool: 'claude', thinking: 'high' },
      ]);
    });

    it('warns on invalid thinking value type', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        '[[agents]]\nmodel = "claude-sonnet-4-6"\ntool = "claude"\nthinking = true\n',
      );

      const config = loadConfig();
      expect(config.agents).toEqual([{ model: 'claude-sonnet-4-6', tool: 'claude' }]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('thinking'));
      warnSpy.mockRestore();
    });

    it('skips invalid entries and warns', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        '[[agents]]\nmodel = "valid"\ntool = "claude"\n[[agents]]\nbroken = true\n',
      );

      const config = loadConfig();
      expect(config.agents).toEqual([{ model: 'valid', tool: 'claude' }]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('agents[1]'));
      warnSpy.mockRestore();
    });

    it('saveConfig writes agents when not null', () => {
      saveConfig({
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
        codebaseDir: null,
        agentCommand: null,
        agents: [{ model: 'glm-5', tool: 'qwen', command: 'qwen -y -m glm-5' }],
      });

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('agents');
      expect(written).toContain('glm-5');
    });

    it('saveConfig omits agents when null', () => {
      saveConfig({
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
        codebaseDir: null,
        agentCommand: null,
        agents: null,
      });

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).not.toContain('agents');
    });
  });

  describe('agent name parsing', () => {
    it('parses name from agent entries', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
name = "SecurityBot"
model = "claude-sonnet-4-6"
tool = "claude"
[[agents]]
model = "glm-5"
tool = "qwen"
`);
      const config = loadConfig();
      expect(config.agents).toHaveLength(2);
      expect(config.agents![0].name).toBe('SecurityBot');
      expect(config.agents![1].name).toBeUndefined();
    });

    it('round-trips name through save and load', () => {
      saveConfig({
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
        codebaseDir: null,
        agentCommand: null,
        agents: [{ model: 'claude-sonnet-4-6', tool: 'claude', name: 'MyBot' }],
      });

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('name = "MyBot"');
    });
  });

  describe('agent review_only config', () => {
    it('parses review_only: true from agent entries', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "gpt-5-codex"
tool = "codex"
review_only = true
[[agents]]
model = "claude-sonnet-4-6"
tool = "claude"
`);
      const config = loadConfig();
      expect(config.agents).toHaveLength(2);
      expect(config.agents![0].review_only).toBe(true);
      expect(config.agents![1].review_only).toBeUndefined();
    });

    it('ignores review_only: false', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-sonnet-4-6"
tool = "claude"
review_only = false
`);
      const config = loadConfig();
      expect(config.agents![0].review_only).toBeUndefined();
    });
  });

  describe('agent router config', () => {
    it('parses router: true from agent entries', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-sonnet-4-6"
tool = "claude"
router = true
[[agents]]
model = "glm-5"
tool = "qwen"
`);
      const config = loadConfig();
      expect(config.agents).toHaveLength(2);
      expect(config.agents![0].router).toBe(true);
      expect(config.agents![1].router).toBeUndefined();
    });

    it('ignores router: false', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-sonnet-4-6"
tool = "claude"
router = false
`);
      const config = loadConfig();
      expect(config.agents![0].router).toBeUndefined();
    });
  });

  describe('repo config parsing', () => {
    it('defaults to undefined repos when omitted', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
`);
      const config = loadConfig();
      expect(config.agents![0].repos).toBeUndefined();
    });

    it('parses repos with mode: all', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
[agents.repos]
mode = "all"
`);
      const config = loadConfig();
      expect(config.agents![0].repos).toEqual({ mode: 'all' });
    });

    it('parses repos with mode: own', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
[agents.repos]
mode = "own"
`);
      const config = loadConfig();
      expect(config.agents![0].repos).toEqual({ mode: 'own' });
    });

    it('parses repos with mode: whitelist and list', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
[agents.repos]
mode = "whitelist"
list = ["OpenCara/OpenCara", "myorg/my-project"]
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
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
[agents.repos]
mode = "blacklist"
list = ["spam-org/spam-repo"]
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
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
[agents.repos]
mode = "invalid"
`);
      expect(() => loadConfig()).toThrow(RepoConfigError);
      expect(() => loadConfig()).toThrow('must be one of: all, own, whitelist, blacklist');
    });

    it('throws RepoConfigError when mode is missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
[agents.repos]
list = ["foo/bar"]
`);
      expect(() => loadConfig()).toThrow(RepoConfigError);
      expect(() => loadConfig()).toThrow('mode is required');
    });

    it('throws RepoConfigError when repos is not an object', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
repos = "just-a-string"
`);
      expect(() => loadConfig()).toThrow(RepoConfigError);
      expect(() => loadConfig()).toThrow('must be an object');
    });

    it('throws RepoConfigError when whitelist has no list', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
[agents.repos]
mode = "whitelist"
`);
      expect(() => loadConfig()).toThrow(RepoConfigError);
      expect(() => loadConfig()).toThrow('list is required and must be non-empty');
    });

    it('throws RepoConfigError when blacklist has empty list', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
[agents.repos]
mode = "blacklist"
list = []
`);
      expect(() => loadConfig()).toThrow(RepoConfigError);
      expect(() => loadConfig()).toThrow('list is required and must be non-empty');
    });

    it('throws RepoConfigError for invalid owner/repo format', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
[agents.repos]
mode = "whitelist"
list = ["invalid-no-slash"]
`);
      expect(() => loadConfig()).toThrow(RepoConfigError);
      expect(() => loadConfig()).toThrow("must match 'owner/repo' format");
    });

    it('throws RepoConfigError for list entry with multiple slashes', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
[agents.repos]
mode = "whitelist"
list = ["a/b/c"]
`);
      expect(() => loadConfig()).toThrow(RepoConfigError);
      expect(() => loadConfig()).toThrow("must match 'owner/repo' format");
    });

    it('does not require list for mode: all', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
[agents.repos]
mode = "all"
`);
      const config = loadConfig();
      expect(config.agents![0].repos).toEqual({ mode: 'all' });
      expect(config.agents![0].repos!.list).toBeUndefined();
    });

    it('does not require list for mode: own', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
[agents.repos]
mode = "own"
`);
      const config = loadConfig();
      expect(config.agents![0].repos).toEqual({ mode: 'own' });
      expect(config.agents![0].repos!.list).toBeUndefined();
    });

    it('saveConfig persists repos field on agents', () => {
      saveConfig({
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
        codebaseDir: null,
        agentCommand: null,
        agents: [
          {
            model: 'claude-opus-4-6',
            tool: 'claude',
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

  describe('deprecated config fields', () => {
    it('logs deprecation warning for github_token', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('github_token = "ghp_abc123"\n');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      loadConfig();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('github_token is deprecated'));
      warnSpy.mockRestore();
    });

    it('logs deprecation warning for github_username', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('github_username = "octocat"\n');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      loadConfig();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('github_username is deprecated'),
      );
      warnSpy.mockRestore();
    });

    it('logs deprecation warning for per-agent github_token', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
github_token = "ghp_agent1"
`);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      loadConfig();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('agents[0].github_token is deprecated'),
      );
      warnSpy.mockRestore();
    });

    it('saveConfig does not write github_token or github_username', () => {
      saveConfig({
        platformUrl: DEFAULT_PLATFORM_URL,
        apiKey: null,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
        codebaseDir: null,
        agentCommand: null,
        agents: null,
        usageLimits: { maxReviewsPerDay: null, maxTokensPerDay: null, maxTokensPerReview: null },
      });

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).not.toContain('github_token');
      expect(content).not.toContain('github_username');
    });
  });

  describe('codebase_dir config', () => {
    it('parses global codebase_dir', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('codebase_dir = "~/.opencara/repos"\n');

      const config = loadConfig();
      expect(config.codebaseDir).toBe('~/.opencara/repos');
    });

    it('returns null for non-string codebase_dir', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('codebase_dir = 123\n');

      const config = loadConfig();
      expect(config.codebaseDir).toBeNull();
    });

    it('returns null when codebase_dir is absent', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('api_key = "cr_test"\n');

      const config = loadConfig();
      expect(config.codebaseDir).toBeNull();
    });

    it('saveConfig writes codebase_dir when present', () => {
      saveConfig({
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
        codebaseDir: '~/.opencara/repos',
        agentCommand: null,
        agents: null,
      });

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).toContain('codebase_dir = "~/.opencara/repos"');
    });

    it('saveConfig omits codebase_dir when null', () => {
      saveConfig({
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
        codebaseDir: null,
        agentCommand: null,
        agents: null,
      });

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).not.toContain('codebase_dir');
    });

    it('parses per-agent codebase_dir', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
codebase_dir = "~/repos"
[[agents]]
model = "glm-5"
tool = "qwen"
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

  describe('config validation', () => {
    describe('platform_url validation', () => {
      it('throws ConfigValidationError for invalid URL', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url = "not-a-url"\n');

        expect(() => loadConfig()).toThrow(ConfigValidationError);
        expect(() => loadConfig()).toThrow('platform_url "not-a-url" is not a valid URL');
      });

      it('accepts valid URL', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url = "https://example.com"\n');

        const config = loadConfig();
        expect(config.platformUrl).toBe('https://example.com');
      });

      it('skips URL validation when env var overrides', () => {
        process.env.OPENCARA_PLATFORM_URL = 'https://env.dev';
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url = "not-a-url"\n');

        const config = loadConfig();
        expect(config.platformUrl).toBe('https://env.dev');
        delete process.env.OPENCARA_PLATFORM_URL;
      });

      it('does not throw for non-string platform_url (falls back to default)', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url = 123\n');

        const config = loadConfig();
        expect(config.platformUrl).toBe(DEFAULT_PLATFORM_URL);
      });

      it('rejects non-HTTP URL schemes', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url = "file:///etc/passwd"\n');

        expect(() => loadConfig()).toThrow(ConfigValidationError);
        expect(() => loadConfig()).toThrow('is not a valid URL');
      });

      it('accepts http URL', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url = "http://localhost:8787"\n');

        const config = loadConfig();
        expect(config.platformUrl).toBe('http://localhost:8787');
      });
    });

    describe('numeric bounds validation', () => {
      it('warns and uses default for max_diff_size_kb <= 0', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('max_diff_size_kb = -5\n');

        const config = loadConfig();
        expect(config.maxDiffSizeKb).toBe(DEFAULT_MAX_DIFF_SIZE_KB);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('max_diff_size_kb must be > 0'),
        );
        warnSpy.mockRestore();
      });

      it('warns and uses default for max_diff_size_kb = 0', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('max_diff_size_kb = 0\n');

        const config = loadConfig();
        expect(config.maxDiffSizeKb).toBe(DEFAULT_MAX_DIFF_SIZE_KB);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('max_diff_size_kb must be > 0'),
        );
        warnSpy.mockRestore();
      });

      it('accepts positive max_diff_size_kb', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('max_diff_size_kb = 200\n');

        const config = loadConfig();
        expect(config.maxDiffSizeKb).toBe(200);
      });

      it('warns and uses default for max_consecutive_errors <= 0', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('max_consecutive_errors = -1\n');

        const config = loadConfig();
        expect(config.maxConsecutiveErrors).toBe(DEFAULT_MAX_CONSECUTIVE_ERRORS);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('max_consecutive_errors must be > 0'),
        );
        warnSpy.mockRestore();
      });

      it('warns and uses default for max_consecutive_errors = 0', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('max_consecutive_errors = 0\n');

        const config = loadConfig();
        expect(config.maxConsecutiveErrors).toBe(DEFAULT_MAX_CONSECUTIVE_ERRORS);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('max_consecutive_errors must be > 0'),
        );
        warnSpy.mockRestore();
      });

      it('accepts positive max_consecutive_errors', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('max_consecutive_errors = 5\n');

        const config = loadConfig();
        expect(config.maxConsecutiveErrors).toBe(5);
      });
    });

    describe('agent tool validation', () => {
      it('skips agent with unrecognized tool and warns', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "some-model"
tool = "invalid-tool"
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
`);

        const config = loadConfig();
        expect(config.agents).toHaveLength(1);
        expect(config.agents![0].tool).toBe('claude');
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('agents[0].tool "invalid-tool" not in registry'),
        );
        warnSpy.mockRestore();
      });

      it('accepts all valid registry tools', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
[[agents]]
model = "gpt-5-codex"
tool = "codex"
[[agents]]
model = "gemini-2.5-pro"
tool = "gemini"
[[agents]]
model = "qwen3.5-plus"
tool = "qwen"
`);

        const config = loadConfig();
        expect(config.agents).toHaveLength(4);
      });

      it('auto-migrates claude-code to claude with deprecation warning', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude-code"
`);

        const config = loadConfig();
        expect(config.agents).toHaveLength(1);
        expect(config.agents![0].tool).toBe('claude');
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('"claude-code" is deprecated, using "claude"'),
        );
        warnSpy.mockRestore();
      });

      it('warning message includes known tool names', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "m"
tool = "unknown"
`);

        loadConfig();
        const msg = warnSpy.mock.calls[0][0] as string;
        expect(msg).toContain('claude');
        expect(msg).toContain('codex');
        expect(msg).toContain('gemini');
        expect(msg).toContain('qwen');
        warnSpy.mockRestore();
      });
    });

    describe('agent entry validation', () => {
      it('warns with correct format for agent entry missing model/tool', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
broken = true
`);

        const config = loadConfig();
        expect(config.agents).toEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Config warning: agents[0] missing required model/tool fields'),
        );
        warnSpy.mockRestore();
      });

      it('warns with correct format for missing model/tool', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
name = "incomplete"
`);

        const config = loadConfig();
        expect(config.agents).toEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Config warning: agents[0] missing required model/tool fields'),
        );
        warnSpy.mockRestore();
      });
    });
  });

  describe('synthesizer_only config', () => {
    it('parses synthesizer_only: true from agent entries', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
synthesizer_only = true
[[agents]]
model = "glm-5"
tool = "qwen"
`);
      const config = loadConfig();
      expect(config.agents).toHaveLength(2);
      expect(config.agents![0].synthesizer_only).toBe(true);
      expect(config.agents![1].synthesizer_only).toBeUndefined();
    });

    it('ignores synthesizer_only: false', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
synthesizer_only = false
`);
      const config = loadConfig();
      expect(config.agents![0].synthesizer_only).toBeUndefined();
    });

    it('throws ConfigValidationError when both review_only and synthesizer_only are true', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
review_only = true
synthesizer_only = true
`);
      expect(() => loadConfig()).toThrow(ConfigValidationError);
      expect(() => loadConfig()).toThrow('review_only and synthesizer_only cannot both be true');
    });

    it('allows review_only: true without synthesizer_only', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
review_only = true
`);
      const config = loadConfig();
      expect(config.agents![0].review_only).toBe(true);
      expect(config.agents![0].synthesizer_only).toBeUndefined();
    });

    it('allows synthesizer_only: true without review_only', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
synthesizer_only = true
`);
      const config = loadConfig();
      expect(config.agents![0].synthesizer_only).toBe(true);
      expect(config.agents![0].review_only).toBeUndefined();
    });
  });

  describe('agent roles config', () => {
    it('parses roles array from agent entries', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
roles = ["review", "summary", "pr_dedup"]
`);
      const config = loadConfig();
      expect(config.agents![0].roles).toEqual(['review', 'summary', 'pr_dedup']);
    });

    it('defaults to undefined roles when omitted', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
`);
      const config = loadConfig();
      expect(config.agents![0].roles).toBeUndefined();
    });

    it('parses roles with multiple valid entries', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
roles = ["review", "summary"]
`);
      const config = loadConfig();
      expect(config.agents![0].roles).toEqual(['review', 'summary']);
    });

    it('does not set roles when array is empty', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
roles = []
`);
      const config = loadConfig();
      expect(config.agents![0].roles).toBeUndefined();
    });

    it('warns when roles used alongside review_only', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
roles = ["review", "pr_dedup"]
review_only = true
`);
      const config = loadConfig();
      expect(config.agents![0].roles).toEqual(['review', 'pr_dedup']);
      expect(config.agents![0].review_only).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'roles' takes precedence"));
      warnSpy.mockRestore();
    });

    it('warns when roles used alongside synthesizer_only', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
roles = ["summary"]
synthesizer_only = true
`);
      const config = loadConfig();
      expect(config.agents![0].roles).toEqual(['summary']);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'roles' takes precedence"));
      warnSpy.mockRestore();
    });

    it('does not warn when roles used without review_only or synthesizer_only', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
roles = ["review", "summary", "issue_triage"]
`);
      loadConfig();
      const calls = warnSpy.mock.calls.map((c) => c[0] as string);
      expect(calls.every((c) => !c.includes("'roles' takes precedence"))).toBe(true);
      warnSpy.mockRestore();
    });

    it('saveConfig round-trips roles field', () => {
      saveConfig({
        platformUrl: DEFAULT_PLATFORM_URL,
        apiKey: null,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
        codebaseDir: null,
        agentCommand: null,
        agents: [{ model: 'claude-opus-4-6', tool: 'claude', roles: ['review', 'pr_dedup'] }],
        usageLimits: { maxReviewsPerDay: null, maxTokensPerDay: null, maxTokensPerReview: null },
      });

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('roles');
      expect(written).toContain('review');
      expect(written).toContain('pr_dedup');
    });
  });

  describe('synthesize_repos config', () => {
    it('parses synthesize_repos with mode: whitelist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
[agents.synthesize_repos]
mode = "whitelist"
list = ["OpenCara/OpenCara"]
`);
      const config = loadConfig();
      expect(config.agents![0].synthesize_repos).toEqual({
        mode: 'whitelist',
        list: ['OpenCara/OpenCara'],
      });
    });

    it('defaults to undefined synthesize_repos when omitted', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
`);
      const config = loadConfig();
      expect(config.agents![0].synthesize_repos).toBeUndefined();
    });

    it('throws RepoConfigError for invalid synthesize_repos mode', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
[agents.synthesize_repos]
mode = "invalid"
`);
      expect(() => loadConfig()).toThrow(RepoConfigError);
      expect(() => loadConfig()).toThrow('synthesize_repos.mode must be one of');
    });

    it('allows both repos and synthesize_repos on same agent', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
[[agents]]
model = "claude-opus-4-6"
tool = "claude"
[agents.repos]
mode = "all"
[agents.synthesize_repos]
mode = "whitelist"
list = ["org/repo"]
`);
      const config = loadConfig();
      expect(config.agents![0].repos).toEqual({ mode: 'all' });
      expect(config.agents![0].synthesize_repos).toEqual({
        mode: 'whitelist',
        list: ['org/repo'],
      });
    });
  });
});
