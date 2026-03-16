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
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_PLATFORM_URL,
} from '../config.js';

describe('config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CONFIG_DIR points to ~/.opencrust', () => {
    expect(CONFIG_DIR).toContain('.opencrust');
  });

  it('CONFIG_FILE points to config.yml', () => {
    expect(CONFIG_FILE).toContain('config.yml');
  });

  it('DEFAULT_PLATFORM_URL is correct', () => {
    expect(DEFAULT_PLATFORM_URL).toBe('https://api.opencrust.dev');
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
  });

  describe('saveConfig', () => {
    it('saves config with API key', () => {
      saveConfig({ apiKey: 'cr_test', platformUrl: 'https://api.dev' });

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
      saveConfig({ apiKey: null, platformUrl: 'https://api.dev' });

      expect(fs.writeFileSync).toHaveBeenCalled();
      const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(content).not.toContain('api_key');
      expect(content).toContain('platform_url');
    });
  });

  describe('requireApiKey', () => {
    it('returns API key when present', () => {
      const key = requireApiKey({ apiKey: 'cr_test', platformUrl: 'test' });
      expect(key).toBe('cr_test');
    });

    it('exits when API key is missing', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() =>
        requireApiKey({ apiKey: null, platformUrl: 'test' }),
      ).toThrow('process.exit');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Not authenticated'),
      );

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
});
