import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getToolCommand,
  getSupportedTools,
  executeTool,
  UnsupportedToolError,
  ToolTimeoutError,
} from '../tool-executor.js';

// Mock child_process.execFile
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';

describe('getSupportedTools', () => {
  it('returns all registered tool names', () => {
    const tools = getSupportedTools();
    expect(tools).toContain('claude-code');
    expect(tools).toContain('codex');
    expect(tools).toContain('gemini');
    expect(tools.length).toBe(3);
  });
});

describe('getToolCommand', () => {
  it('returns tool command for claude-code', () => {
    const tool = getToolCommand('claude-code');
    const { command, args } = tool.buildCommand('test prompt');
    expect(command).toBe('claude');
    expect(args).toEqual(['-p', 'test prompt', '--output-format', 'text']);
  });

  it('returns tool command for codex', () => {
    const tool = getToolCommand('codex');
    const { command, args } = tool.buildCommand('test prompt');
    expect(command).toBe('codex');
    expect(args).toEqual(['exec', 'test prompt']);
  });

  it('returns tool command for gemini', () => {
    const tool = getToolCommand('gemini');
    const { command, args } = tool.buildCommand('test prompt');
    expect(command).toBe('gemini');
    expect(args).toEqual(['-p', 'test prompt']);
  });

  it('throws UnsupportedToolError for unknown tool', () => {
    expect(() => getToolCommand('unknown-tool')).toThrow(UnsupportedToolError);
    expect(() => getToolCommand('unknown-tool')).toThrow(/Supported tools:/);
    expect(() => getToolCommand('unknown-tool')).toThrow(/claude-code/);
  });
});

describe('UnsupportedToolError', () => {
  it('has correct name and message', () => {
    const err = new UnsupportedToolError('bad tool');
    expect(err.name).toBe('UnsupportedToolError');
    expect(err.message).toBe('bad tool');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ToolTimeoutError', () => {
  it('has correct name and message', () => {
    const err = new ToolTimeoutError('timed out');
    expect(err.name).toBe('ToolTimeoutError');
    expect(err.message).toBe('timed out');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('executeTool', () => {
  const mockExecFile = vi.mocked(execFile);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invokes the correct command for claude-code', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as (error: Error | null, stdout: string) => void)(null, 'VERDICT: APPROVE\nLGTM');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await executeTool('claude-code', 'Review this', 60_000);

    expect(mockExecFile).toHaveBeenCalledWith(
      'claude',
      ['-p', 'Review this', '--output-format', 'text'],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      expect.any(Function),
    );
    expect(result.stdout).toBe('VERDICT: APPROVE\nLGTM');
    expect(result.tokensUsed).toBe(0);
  });

  it('invokes the correct command for codex', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as (error: Error | null, stdout: string) => void)(null, 'output');
      return {} as ReturnType<typeof execFile>;
    });

    await executeTool('codex', 'Do something', 30_000);

    expect(mockExecFile).toHaveBeenCalledWith(
      'codex',
      ['exec', 'Do something'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('invokes the correct command for gemini', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as (error: Error | null, stdout: string) => void)(null, 'output');
      return {} as ReturnType<typeof execFile>;
    });

    await executeTool('gemini', 'Analyze code', 30_000);

    expect(mockExecFile).toHaveBeenCalledWith(
      'gemini',
      ['-p', 'Analyze code'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('throws UnsupportedToolError for unknown tool', () => {
    expect(() => executeTool('nonexistent', 'test', 30_000)).toThrow(UnsupportedToolError);
  });

  it('throws ToolTimeoutError when process is killed', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      const error = Object.assign(new Error('killed'), { killed: true });
      (cb as (error: Error | null, stdout: string) => void)(error, '');
      return {} as ReturnType<typeof execFile>;
    });

    await expect(executeTool('claude-code', 'test', 30_000)).rejects.toThrow(ToolTimeoutError);
    await expect(executeTool('claude-code', 'test', 30_000)).rejects.toThrow(/timed out/);
  });

  it('propagates non-timeout errors', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as (error: Error | null, stdout: string) => void)(
        new Error('Command not found: claude'),
        '',
      );
      return {} as ReturnType<typeof execFile>;
    });

    await expect(executeTool('claude-code', 'test', 30_000)).rejects.toThrow(
      'Command not found: claude',
    );
  });

  it('rejects immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(executeTool('claude-code', 'test', 30_000, controller.signal)).rejects.toThrow(
      ToolTimeoutError,
    );
  });

  it('kills child process when signal is aborted', async () => {
    const killFn = vi.fn();

    mockExecFile.mockImplementation((_cmd, _args, _opts, _cb) => {
      // Don't call callback - simulate a long-running process
      return { kill: killFn } as unknown as ReturnType<typeof execFile>;
    });

    const controller = new AbortController();

    // Start execution (won't resolve because callback isn't called)
    const promise = executeTool('claude-code', 'test', 60_000, controller.signal);

    // Abort the signal
    controller.abort();

    // The kill function should have been called
    expect(killFn).toHaveBeenCalled();

    // The callback will eventually be called by the mock on abort, but we need to
    // simulate that for our test. Let's manually trigger the callback.
    const cb = mockExecFile.mock.calls[0][3] as (error: Error | null, stdout: string) => void;
    cb(null, ''); // The callback fires but signal is aborted so it rejects

    await expect(promise).rejects.toThrow(ToolTimeoutError);
  });
});
