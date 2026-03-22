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
  resolveLogFile,
  resolveGithubToken,
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

      expect(config.platformUrl).toBe(DEFAULT_PLATFORM_URL);
      expect(config.maxDiffSizeKb).toBe(DEFAULT_MAX_DIFF_SIZE_KB);
      expect(config.maxConsecutiveErrors).toBe(DEFAULT_MAX_CONSECUTIVE_ERRORS);
      expect(config.githubToken).toBeNull();
      expect(config.codebaseDir).toBeNull();
      expect(config.agentCommand).toBeNull();
    });

    it('parses valid config file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('platform_url: https://custom.dev\n');

      const config = loadConfig();

      expect(config.platformUrl).toBe('https://custom.dev');
    });

    it('parses max_diff_size_kb config field', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('max_diff_size_kb: 200\n');

      const config = loadConfig();

      expect(config.maxDiffSizeKb).toBe(200);
    });

    it('parses max_consecutive_errors config field', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('max_consecutive_errors: 5\n');

      const config = loadConfig();

      expect(config.maxConsecutiveErrors).toBe(5);
    });

    it('returns default for non-number max_consecutive_errors', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('max_consecutive_errors: many\n');

      const config = loadConfig();
      expect(config.maxConsecutiveErrors).toBe(DEFAULT_MAX_CONSECUTIVE_ERRORS);
    });

    it('returns defaults for non-number max_diff_size_kb', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('max_diff_size_kb: big\n');

      const config = loadConfig();
      expect(config.maxDiffSizeKb).toBe(DEFAULT_MAX_DIFF_SIZE_KB);
    });

    it('silently ignores old anthropic_api_key, review_model, and api_key fields', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        'anthropic_api_key: sk-ant-test\nreview_model: claude-opus-4-6\napi_key: cr_test\n',
      );

      const config = loadConfig();

      // Old fields are ignored, no errors thrown
      expect(config).not.toHaveProperty('anthropicApiKey');
      expect(config).not.toHaveProperty('reviewModel');
      expect(config).not.toHaveProperty('apiKey');
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
      vi.mocked(fs.readFileSync).mockReturnValue('some_other: value\n');

      const config = loadConfig();

      expect(config.platformUrl).toBe(DEFAULT_PLATFORM_URL);
    });

    it('handles config with non-string platform_url', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('platform_url: 123\n');

      const config = loadConfig();

      expect(config.platformUrl).toBe(DEFAULT_PLATFORM_URL);
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

    describe('OPENCARA_PLATFORM_URL env var', () => {
      const ENV_KEY = 'OPENCARA_PLATFORM_URL';

      afterEach(() => {
        delete process.env[ENV_KEY];
      });

      it('env var overrides config file value', () => {
        process.env[ENV_KEY] = 'https://env-override.dev';
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url: https://from-config.dev\n');

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
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url: https://from-config.dev\n');

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
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url: https://from-config.dev\n');

        const config = loadConfig();

        expect(config.platformUrl).toBe('https://from-config.dev');
      });

      it('whitespace-only env var falls back to config file', () => {
        process.env[ENV_KEY] = '   ';
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url: https://from-config.dev\n');

        const config = loadConfig();

        expect(config.platformUrl).toBe('https://from-config.dev');
      });
    });
  });

  describe('saveConfig', () => {
    const baseConfig = {
      platformUrl: 'https://api.dev',
      maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
      maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
      githubToken: null as string | null,
      codebaseDir: null as string | null,

      agentCommand: null as string | null,
      agents: null as import('../config.js').LocalAgentConfig[] | null,
    };

    it('saves config with platform_url', () => {
      saveConfig(baseConfig);

      expect(fs.mkdirSync).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        CONFIG_FILE,
        expect.stringContaining('platform_url: https://api.dev'),
        { encoding: 'utf-8', mode: 0o600 },
      );
    });

    it('does not save api_key, anthropic_api_key or review_model', () => {
      saveConfig(baseConfig);

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).not.toContain('api_key');
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

    it('saves max_consecutive_errors when non-default', () => {
      saveConfig({ ...baseConfig, maxConsecutiveErrors: 5 });

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).toContain('max_consecutive_errors: 5');
    });

    it('does not save max_consecutive_errors when default', () => {
      saveConfig(baseConfig);

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).not.toContain('max_consecutive_errors');
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
        'api_key: cr_test\nagents:\n  - model: claude-opus-4-6\n    tool: claude\n    command: claude -p\n',
      );

      const config = loadConfig();
      expect(config.agents).toEqual([
        { model: 'claude-opus-4-6', tool: 'claude', command: 'claude -p' },
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
        'agents:\n  - model: valid\n    tool: claude\n  - broken: true\n',
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
        githubToken: null,
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
        githubToken: null,
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
agents:
  - name: SecurityBot
    model: claude-sonnet-4-6
    tool: claude
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
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
        githubToken: null,
        codebaseDir: null,
        agentCommand: null,
        agents: [{ model: 'claude-sonnet-4-6', tool: 'claude', name: 'MyBot' }],
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
    tool: claude
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
    tool: claude
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
    tool: claude
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
    tool: claude
    router: false
`);
      const config = loadConfig();
      expect(config.agents![0].router).toBeUndefined();
    });
  });

  describe('repo config parsing', () => {
    it('defaults to undefined repos when omitted', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude
`);
      const config = loadConfig();
      expect(config.agents![0].repos).toBeUndefined();
    });

    it('parses repos with mode: all', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude
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
    tool: claude
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
    tool: claude
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
    tool: claude
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
    tool: claude
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
    tool: claude
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
    tool: claude
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
    tool: claude
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
    tool: claude
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
    tool: claude
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
    tool: claude
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
    tool: claude
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
    tool: claude
    repos:
      mode: own
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
        githubToken: null,
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
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
        githubToken: 'ghp_xyz789',
        codebaseDir: null,
        agentCommand: null,
        agents: null,
      });

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).toContain('github_token: ghp_xyz789');
    });

    it('saveConfig omits github_token when null', () => {
      saveConfig({
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
        githubToken: null,
        codebaseDir: null,
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
    tool: claude
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
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
        githubToken: null,
        codebaseDir: '~/.opencara/repos',
        agentCommand: null,
        agents: null,
      });

      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).toContain('codebase_dir: ~/.opencara/repos');
    });

    it('saveConfig omits codebase_dir when null', () => {
      saveConfig({
        platformUrl: DEFAULT_PLATFORM_URL,
        maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
        maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
        githubToken: null,
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
agents:
  - model: claude-opus-4-6
    tool: claude
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

  describe('resolveLogFile', () => {
    it('returns null when both args are absent', () => {
      expect(resolveLogFile(undefined, null)).toBeNull();
    });

    it('uses global when agent is undefined', () => {
      expect(resolveLogFile(undefined, '/tmp/global.log')).toBe('/tmp/global.log');
    });

    it('uses agent when global is null', () => {
      expect(resolveLogFile('/tmp/agent.log', null)).toBe('/tmp/agent.log');
    });

    it('agent overrides global', () => {
      expect(resolveLogFile('/tmp/agent.log', '/tmp/global.log')).toBe('/tmp/agent.log');
    });

    it('expands tilde in path', () => {
      const result = resolveLogFile(undefined, '~/logs/agent.log');
      expect(result).not.toContain('~');
      expect(result).toContain('logs/agent.log');
    });

    it('returns null for empty string agent with null global', () => {
      expect(resolveLogFile('', null)).toBeNull();
    });
  });

  describe('config validation', () => {
    describe('platform_url validation', () => {
      it('throws ConfigValidationError for invalid URL', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url: not-a-url\n');

        expect(() => loadConfig()).toThrow(ConfigValidationError);
        expect(() => loadConfig()).toThrow('platform_url "not-a-url" is not a valid URL');
      });

      it('accepts valid URL', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url: https://example.com\n');

        const config = loadConfig();
        expect(config.platformUrl).toBe('https://example.com');
      });

      it('skips URL validation when env var overrides', () => {
        process.env.OPENCARA_PLATFORM_URL = 'https://env.dev';
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url: not-a-url\n');

        const config = loadConfig();
        expect(config.platformUrl).toBe('https://env.dev');
        delete process.env.OPENCARA_PLATFORM_URL;
      });

      it('does not throw for non-string platform_url (falls back to default)', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url: 123\n');

        const config = loadConfig();
        expect(config.platformUrl).toBe(DEFAULT_PLATFORM_URL);
      });

      it('rejects non-HTTP URL schemes', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url: file:///etc/passwd\n');

        expect(() => loadConfig()).toThrow(ConfigValidationError);
        expect(() => loadConfig()).toThrow('is not a valid URL');
      });

      it('accepts http URL', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url: http://localhost:8787\n');

        const config = loadConfig();
        expect(config.platformUrl).toBe('http://localhost:8787');
      });
    });

    describe('numeric bounds validation', () => {
      it('warns and uses default for max_diff_size_kb <= 0', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('max_diff_size_kb: -5\n');

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
        vi.mocked(fs.readFileSync).mockReturnValue('max_diff_size_kb: 0\n');

        const config = loadConfig();
        expect(config.maxDiffSizeKb).toBe(DEFAULT_MAX_DIFF_SIZE_KB);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('max_diff_size_kb must be > 0'),
        );
        warnSpy.mockRestore();
      });

      it('accepts positive max_diff_size_kb', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('max_diff_size_kb: 200\n');

        const config = loadConfig();
        expect(config.maxDiffSizeKb).toBe(200);
      });

      it('warns and uses default for max_consecutive_errors <= 0', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('max_consecutive_errors: -1\n');

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
        vi.mocked(fs.readFileSync).mockReturnValue('max_consecutive_errors: 0\n');

        const config = loadConfig();
        expect(config.maxConsecutiveErrors).toBe(DEFAULT_MAX_CONSECUTIVE_ERRORS);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('max_consecutive_errors must be > 0'),
        );
        warnSpy.mockRestore();
      });

      it('accepts positive max_consecutive_errors', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('max_consecutive_errors: 5\n');

        const config = loadConfig();
        expect(config.maxConsecutiveErrors).toBe(5);
      });
    });

    describe('agent tool validation', () => {
      it('skips agent with unrecognized tool and warns', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: some-model
    tool: invalid-tool
  - model: claude-opus-4-6
    tool: claude
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
agents:
  - model: claude-opus-4-6
    tool: claude
  - model: gpt-5-codex
    tool: codex
  - model: gemini-2.5-pro
    tool: gemini
  - model: qwen3.5-plus
    tool: qwen
`);

        const config = loadConfig();
        expect(config.agents).toHaveLength(4);
      });

      it('auto-migrates claude-code to claude with deprecation warning', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude-code
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
agents:
  - model: m
    tool: unknown
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

    describe('log_file config', () => {
      it('parses global log_file', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('log_file: /tmp/agent.log\n');

        const config = loadConfig();
        expect(config.logFile).toBe('/tmp/agent.log');
      });

      it('defaults to null when not specified', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue('platform_url: https://api.opencara.dev\n');

        const config = loadConfig();
        expect(config.logFile).toBeNull();
      });

      it('parses per-agent log_file', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - model: claude-opus-4-6
    tool: claude
    log_file: /tmp/claude.log
`);

        const config = loadConfig();
        expect(config.agents![0].log_file).toBe('/tmp/claude.log');
      });

      it('saves log_file in config', () => {
        saveConfig({
          platformUrl: DEFAULT_PLATFORM_URL,
          maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
          maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
          githubToken: null,
          codebaseDir: null,
          agentCommand: null,
          logFile: '/tmp/agent.log',
          agents: null,
        });

        expect(fs.writeFileSync).toHaveBeenCalled();
        const writtenContent = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
        expect(writtenContent).toContain('log_file');
        expect(writtenContent).toContain('/tmp/agent.log');
      });
    });

    describe('agent entry validation', () => {
      it('warns with correct format for non-object agent entry', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - just a string
`);

        const config = loadConfig();
        expect(config.agents).toEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Config warning: agents[0] is not an object'),
        );
        warnSpy.mockRestore();
      });

      it('warns with correct format for missing model/tool', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(`
agents:
  - name: incomplete
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
});
