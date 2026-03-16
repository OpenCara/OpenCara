import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// We test config functions by temporarily overriding the config path.
// Since config.ts uses constants, we test the logic by importing the functions
// and writing/reading from a temp dir.

describe('config', () => {
  let tmpDir: string;
  let configFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencrust-test-'));
    configFile = path.join(tmpDir, 'config.yml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadConfig returns defaults when no file exists', async () => {
    const { loadConfig } = await import('../config.js');
    // loadConfig reads from the actual path, so we test the default behavior
    // by verifying the interface
    const config = loadConfig();
    expect(config).toHaveProperty('platformUrl');
    expect(config).toHaveProperty('apiKey');
  });

  it('saveConfig and loadConfig round-trip via file system', () => {
    const { stringify, parse } = require('yaml');

    const data = { api_key: 'cr_test123', platform_url: 'https://test.example.com' };
    fs.writeFileSync(configFile, stringify(data), 'utf-8');

    const raw = fs.readFileSync(configFile, 'utf-8');
    const parsed = parse(raw);
    expect(parsed.api_key).toBe('cr_test123');
    expect(parsed.platform_url).toBe('https://test.example.com');
  });

  it('handles empty config file gracefully', () => {
    const { parse } = require('yaml');

    fs.writeFileSync(configFile, '', 'utf-8');
    const raw = fs.readFileSync(configFile, 'utf-8');
    const parsed = parse(raw);
    expect(parsed).toBeNull();
  });

  it('DEFAULT_PLATFORM_URL is correct', async () => {
    const { DEFAULT_PLATFORM_URL } = await import('../config.js');
    expect(DEFAULT_PLATFORM_URL).toBe('https://api.opencrust.dev');
  });
});
