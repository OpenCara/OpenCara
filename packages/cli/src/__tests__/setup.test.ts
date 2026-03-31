import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:fs before importing setup
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// Mock node:child_process
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

// Mock node:readline
vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:readline')>();
  return {
    ...actual,
    createInterface: vi.fn(),
  };
});

// Mock tool-executor
vi.mock('../tool-executor.js', () => ({
  validateCommandBinary: vi.fn(),
}));

// Mock config
vi.mock('../config.js', () => ({
  CONFIG_FILE: '/home/test/.opencara/config.toml',
  ensureConfigDir: vi.fn(),
}));

import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import * as readline from 'node:readline';
import { validateCommandBinary } from '../tool-executor.js';
import { ensureConfigDir } from '../config.js';
import {
  checkPrerequisites,
  discoverTools,
  generateConfig,
  interactiveSetup,
  SCANNABLE_TOOLS,
  DEFAULT_MODELS,
  resolveDefaultModel,
  type DiscoveredTool,
} from '../setup.js';

const mockedValidateCommandBinary = vi.mocked(validateCommandBinary);
const mockedExecFileSync = vi.mocked(childProcess.execFileSync);
const mockedCreateInterface = vi.mocked(readline.createInterface);
const mockedWriteFileSync = vi.mocked(fs.writeFileSync);
const mockedEnsureConfigDir = vi.mocked(ensureConfigDir);

describe('setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SCANNABLE_TOOLS', () => {
    it('contains exactly claude, codex, gemini', () => {
      expect(SCANNABLE_TOOLS).toEqual(['claude', 'codex', 'gemini']);
    });

    it('does not contain qwen or others', () => {
      expect(SCANNABLE_TOOLS).not.toContain('qwen');
    });
  });

  describe('DEFAULT_MODELS', () => {
    it('maps claude to claude-sonnet-4-6', () => {
      expect(DEFAULT_MODELS['claude']).toBe('claude-sonnet-4-6');
    });

    it('maps codex to gpt-5-codex', () => {
      expect(DEFAULT_MODELS['codex']).toBe('gpt-5-codex');
    });

    it('maps gemini to gemini-2.5-pro', () => {
      expect(DEFAULT_MODELS['gemini']).toBe('gemini-2.5-pro');
    });
  });

  describe('resolveDefaultModel', () => {
    it('returns DEFAULT_MODELS entry for known tools', () => {
      expect(resolveDefaultModel('claude')).toBe('claude-sonnet-4-6');
      expect(resolveDefaultModel('codex')).toBe('gpt-5-codex');
      expect(resolveDefaultModel('gemini')).toBe('gemini-2.5-pro');
    });

    it('falls back to tool name for unknown tools', () => {
      expect(resolveDefaultModel('unknown-tool')).toBe('unknown-tool');
    });
  });

  describe('checkPrerequisites', () => {
    it('returns git=true and gh=true when both installed and authenticated', () => {
      mockedValidateCommandBinary.mockImplementation((cmd) =>
        cmd === 'git' || cmd === 'gh' ? true : false,
      );
      mockedExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'gh' && Array.isArray(args) && args[0] === 'auth') return Buffer.from('');
        if (cmd === 'gh' && Array.isArray(args) && args[0] === 'api')
          return Buffer.from('octocat\n');
        return Buffer.from('');
      });

      const result = checkPrerequisites();
      expect(result.git).toBe(true);
      expect(result.gh).toBe(true);
      expect(result.ghAuthenticated).toBe(true);
      expect(result.ghUsername).toBe('octocat');
    });

    it('returns git=false when git not installed', () => {
      mockedValidateCommandBinary.mockReturnValue(false);
      const result = checkPrerequisites();
      expect(result.git).toBe(false);
      expect(result.gh).toBe(false);
    });

    it('returns gh=false when gh not installed', () => {
      mockedValidateCommandBinary.mockImplementation((cmd) => cmd === 'git');
      const result = checkPrerequisites();
      expect(result.git).toBe(true);
      expect(result.gh).toBe(false);
      expect(result.ghAuthenticated).toBe(false);
      expect(result.ghUsername).toBeNull();
    });

    it('returns ghAuthenticated=false when gh auth fails', () => {
      mockedValidateCommandBinary.mockReturnValue(true);
      mockedExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'gh' && Array.isArray(args) && args[0] === 'auth') {
          throw new Error('not authenticated');
        }
        return Buffer.from('');
      });

      const result = checkPrerequisites();
      expect(result.gh).toBe(true);
      expect(result.ghAuthenticated).toBe(false);
      expect(result.ghUsername).toBeNull();
    });

    it('handles gh username fetch failure gracefully', () => {
      mockedValidateCommandBinary.mockReturnValue(true);
      mockedExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'gh' && Array.isArray(args) && args[0] === 'auth') return Buffer.from('');
        if (cmd === 'gh' && Array.isArray(args) && args[0] === 'api') {
          throw new Error('API error');
        }
        return Buffer.from('');
      });

      const result = checkPrerequisites();
      expect(result.ghAuthenticated).toBe(true);
      expect(result.ghUsername).toBeNull();
    });
  });

  describe('discoverTools', () => {
    it('returns only tools that are installed', () => {
      mockedValidateCommandBinary.mockImplementation((cmd) => cmd === 'claude' || cmd === 'gemini');

      const result = discoverTools();
      expect(result).toHaveLength(2);
      expect(result[0].toolName).toBe('claude');
      expect(result[1].toolName).toBe('gemini');
    });

    it('returns empty array when no tools installed', () => {
      mockedValidateCommandBinary.mockReturnValue(false);
      const result = discoverTools();
      expect(result).toHaveLength(0);
    });

    it('returns default models for discovered tools', () => {
      mockedValidateCommandBinary.mockImplementation((cmd) => cmd === 'codex');
      const result = discoverTools();
      expect(result[0].defaultModel).toBe('gpt-5-codex');
    });

    it('only scans SCANNABLE_TOOLS (not qwen or others)', () => {
      mockedValidateCommandBinary.mockReturnValue(true);
      const result = discoverTools();
      // Should only have claude, codex, gemini — not qwen
      expect(result.map((t) => t.toolName)).toEqual(['claude', 'codex', 'gemini']);
    });
  });

  describe('generateConfig', () => {
    it('generates valid TOML with reviewer and summarizer roles', () => {
      const tools: DiscoveredTool[] = [
        { toolName: 'claude', defaultModel: 'claude-sonnet-4-6', maxTasksPerDay: 3 },
      ];
      const config = generateConfig(tools);
      expect(config).toContain('[[agents]]');
      expect(config).toContain('tool = "claude"');
      expect(config).toContain('model = "claude-sonnet-4-6"');
      expect(config).toContain('roles = ["review", "summary"]');
      expect(config).toContain('max_tasks_per_day = 3');
    });

    it('does not include implement/fix/dedup/triage roles', () => {
      const tools: DiscoveredTool[] = [
        { toolName: 'codex', defaultModel: 'gpt-5-codex', maxTasksPerDay: 1 },
      ];
      const config = generateConfig(tools);
      expect(config).not.toContain('implement');
      expect(config).not.toContain('fix');
      expect(config).not.toContain('dedup');
      expect(config).not.toContain('triage');
    });

    it('generates one [[agents]] block per tool', () => {
      const tools: DiscoveredTool[] = [
        { toolName: 'claude', defaultModel: 'claude-sonnet-4-6', maxTasksPerDay: 1 },
        { toolName: 'codex', defaultModel: 'gpt-5-codex', maxTasksPerDay: 2 },
      ];
      const config = generateConfig(tools);
      const agentBlocks = config.match(/\[\[agents\]\]/g);
      expect(agentBlocks).toHaveLength(2);
    });

    it('uses the user-chosen max_tasks_per_day', () => {
      const tools: DiscoveredTool[] = [
        { toolName: 'gemini', defaultModel: 'gemini-2.5-pro', maxTasksPerDay: 5 },
      ];
      const config = generateConfig(tools);
      expect(config).toContain('max_tasks_per_day = 5');
    });

    it('includes comment header', () => {
      const tools: DiscoveredTool[] = [
        { toolName: 'claude', defaultModel: 'claude-sonnet-4-6', maxTasksPerDay: 1 },
      ];
      const config = generateConfig(tools);
      expect(config).toContain('# Auto-generated by opencara');
    });
  });

  describe('interactiveSetup', () => {
    let stdoutOutput: string;

    beforeEach(() => {
      stdoutOutput = '';

      // Capture stdout
      vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
        stdoutOutput += data.toString();
        return true;
      });

      // Mock process.exit
      vi.spyOn(process, 'exit').mockImplementation((_code?: number | string) => {
        throw new Error(`process.exit(${_code})`);
      });
    });

    afterEach(() => {
      vi.mocked(process.stdout.write).mockRestore?.();
      vi.mocked(process.exit).mockRestore?.();
    });

    it('returns false immediately when stdin is not a TTY', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      const result = await interactiveSetup();
      expect(result).toBe(false);
      // Should not print anything in non-TTY mode
      expect(stdoutOutput).toBe('');
    });

    it('calls process.exit(1) when git is missing', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      mockedValidateCommandBinary.mockReturnValue(false);

      await expect(interactiveSetup()).rejects.toThrow('process.exit(1)');
      expect(stdoutOutput).toContain('git is required for opencara');
    });

    it('prints warning and continues when gh is missing', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      mockedValidateCommandBinary.mockImplementation((cmd) => cmd === 'git');

      // Simulate no tools found after gh check
      // discoverTools will return empty since all validateCommandBinary calls for tools return false

      const result = await interactiveSetup();
      expect(stdoutOutput).toContain('GitHub CLI (gh) is recommended');
      expect(stdoutOutput).toContain('No AI tools found');
      expect(result).toBe(false);
    });

    it('prints gh not authenticated warning and continues', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      mockedValidateCommandBinary.mockImplementation((cmd) => cmd === 'git' || cmd === 'gh');
      mockedExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'gh' && Array.isArray(args) && args[0] === 'auth') {
          throw new Error('not logged in');
        }
        return Buffer.from('');
      });

      const result = await interactiveSetup();
      expect(stdoutOutput).toContain('gh auth login');
      expect(result).toBe(false); // no tools found either
    });

    it('returns false and prints install links when no tools found', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      mockedValidateCommandBinary.mockImplementation((cmd) => cmd === 'git');

      const result = await interactiveSetup();
      expect(result).toBe(false);
      expect(stdoutOutput).toContain('No AI tools found');
      expect(stdoutOutput).toContain('claude');
      expect(stdoutOutput).toContain('codex');
      expect(stdoutOutput).toContain('gemini');
    });

    it('writes config and returns true when user accepts', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      // git=true, gh=false (simple case)
      mockedValidateCommandBinary.mockImplementation((cmd) => cmd === 'git' || cmd === 'claude');

      // readline mock: answer 1 for claude limit, 'y' for confirmation
      let questionCount = 0;
      const mockRl = {
        question: vi.fn((q: string, cb: (a: string) => void) => {
          questionCount++;
          if (questionCount === 1)
            cb('3'); // claude limit
          else cb('y'); // confirm
        }),
        close: vi.fn(),
      };
      mockedCreateInterface.mockReturnValue(mockRl as unknown as readline.Interface);

      const result = await interactiveSetup();
      expect(result).toBe(true);
      expect(mockedEnsureConfigDir).toHaveBeenCalled();
      expect(mockedWriteFileSync).toHaveBeenCalledWith(
        '/home/test/.opencara/config.toml',
        expect.stringContaining('max_tasks_per_day = 3'),
        expect.any(Object),
      );
      expect(stdoutOutput).toContain('Config written to');
    });

    it('returns false when user declines config generation', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      mockedValidateCommandBinary.mockImplementation((cmd) => cmd === 'git' || cmd === 'claude');

      let questionCount = 0;
      const mockRl = {
        question: vi.fn((q: string, cb: (a: string) => void) => {
          questionCount++;
          if (questionCount === 1)
            cb(''); // accept default for limit
          else cb('n'); // decline
        }),
        close: vi.fn(),
      };
      mockedCreateInterface.mockReturnValue(mockRl as unknown as readline.Interface);

      const result = await interactiveSetup();
      expect(result).toBe(false);
      expect(mockedWriteFileSync).not.toHaveBeenCalled();
      expect(stdoutOutput).toContain('Skipped');
    });

    it('uses default of 1 when user presses Enter for limit', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      mockedValidateCommandBinary.mockImplementation((cmd) => cmd === 'git' || cmd === 'codex');

      let questionCount = 0;
      const mockRl = {
        question: vi.fn((q: string, cb: (a: string) => void) => {
          questionCount++;
          if (questionCount === 1)
            cb(''); // press Enter -> default 1
          else cb('y');
        }),
        close: vi.fn(),
      };
      mockedCreateInterface.mockReturnValue(mockRl as unknown as readline.Interface);

      await interactiveSetup();
      expect(mockedWriteFileSync).toHaveBeenCalledWith(
        '/home/test/.opencara/config.toml',
        expect.stringContaining('max_tasks_per_day = 1'),
        expect.any(Object),
      );
    });

    it('re-prompts when user enters invalid limit (0 or negative)', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      mockedValidateCommandBinary.mockImplementation((cmd) => cmd === 'git' || cmd === 'claude');

      let questionCount = 0;
      const mockRl = {
        question: vi.fn((q: string, cb: (a: string) => void) => {
          questionCount++;
          if (questionCount === 1)
            cb('0'); // invalid
          else if (questionCount === 2)
            cb('2'); // valid on retry
          else cb('y');
        }),
        close: vi.fn(),
      };
      mockedCreateInterface.mockReturnValue(mockRl as unknown as readline.Interface);

      await interactiveSetup();
      // question should have been asked 3 times: invalid, valid, confirm
      expect(questionCount).toBe(3);
      expect(mockedWriteFileSync).toHaveBeenCalledWith(
        '/home/test/.opencara/config.toml',
        expect.stringContaining('max_tasks_per_day = 2'),
        expect.any(Object),
      );
    });

    it('shows gh username when authenticated', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      mockedValidateCommandBinary.mockImplementation((cmd) => cmd === 'git' || cmd === 'gh');
      mockedExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'gh' && Array.isArray(args) && args[0] === 'auth') return Buffer.from('');
        if (cmd === 'gh' && Array.isArray(args) && args[0] === 'api')
          return Buffer.from('testuser\n');
        return Buffer.from('');
      });

      // no tools found path
      const result = await interactiveSetup();
      expect(stdoutOutput).toContain('@testuser');
      expect(result).toBe(false);
    });

    it('writes config with correct file mode (0o600)', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      mockedValidateCommandBinary.mockImplementation((cmd) => cmd === 'git' || cmd === 'gemini');

      let questionCount = 0;
      const mockRl = {
        question: vi.fn((q: string, cb: (a: string) => void) => {
          questionCount++;
          if (questionCount === 1) cb('1');
          else cb('y');
        }),
        close: vi.fn(),
      };
      mockedCreateInterface.mockReturnValue(mockRl as unknown as readline.Interface);

      await interactiveSetup();
      expect(mockedWriteFileSync).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
        encoding: 'utf-8',
        mode: 0o600,
      });
    });
  });
});
