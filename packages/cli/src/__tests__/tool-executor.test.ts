import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getToolCommand,
  getSupportedTools,
  executeTool,
  extractClaudeCodeResult,
  UnsupportedToolError,
  ToolTimeoutError,
} from '../tool-executor.js';

import EventEmitter from 'node:events';

// We need to mock child_process.spawn
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

/**
 * Helper to create a mock child process for spawn.
 * Uses EventEmitter-based stdout/stderr for predictable event timing.
 */
function createMockChild() {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinChunks: string[] = [];

  const stdin = {
    write: vi.fn((data: string) => {
      stdinChunks.push(data);
    }),
    end: vi.fn(),
  };

  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
    pid: 12345,
  });

  return child as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
}

/** Emit stdout data, stderr data, then close event in the correct order */
function emitOutput(
  child: ReturnType<typeof createMockChild>,
  opts: { stdout?: string; stderr?: string; code?: number | null; signal?: string | null },
) {
  if (opts.stdout !== undefined) {
    child.stdout.emit('data', Buffer.from(opts.stdout));
  }
  if (opts.stderr !== undefined) {
    child.stderr.emit('data', Buffer.from(opts.stderr));
  }
  child.emit('close', opts.code ?? 0, opts.signal ?? null);
}

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
  it('returns tool command for claude-code (no prompt in args)', () => {
    const tool = getToolCommand('claude-code');
    const { command, args } = tool.buildCommand();
    expect(command).toBe('claude');
    expect(args).toEqual(['-p', '--output-format', 'json']);
  });

  it('returns tool command for codex (no prompt in args)', () => {
    const tool = getToolCommand('codex');
    const { command, args } = tool.buildCommand();
    expect(command).toBe('codex');
    expect(args).toEqual(['exec']);
  });

  it('returns tool command for gemini (no prompt in args)', () => {
    const tool = getToolCommand('gemini');
    const { command, args } = tool.buildCommand();
    expect(command).toBe('gemini');
    expect(args).toEqual(['-p']);
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

describe('extractClaudeCodeResult', () => {
  it('extracts result from valid JSON', () => {
    const json = JSON.stringify({ result: 'VERDICT: APPROVE\nLGTM', usage: {} });
    expect(extractClaudeCodeResult(json)).toBe('VERDICT: APPROVE\nLGTM');
  });

  it('returns raw stdout if JSON has no result field', () => {
    const json = JSON.stringify({ output: 'something' });
    expect(extractClaudeCodeResult(json)).toBe(json);
  });

  it('returns raw stdout if not valid JSON', () => {
    const raw = 'VERDICT: APPROVE\nPlain text output';
    expect(extractClaudeCodeResult(raw)).toBe(raw);
  });
});

describe('claude-code parseTokenUsage', () => {
  it('parses token usage from JSON output', () => {
    const tool = getToolCommand('claude-code');
    const json = JSON.stringify({
      result: 'review text',
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    expect(tool.parseTokenUsage!(json)).toBe(1500);
  });

  it('returns 0 when usage is missing', () => {
    const tool = getToolCommand('claude-code');
    const json = JSON.stringify({ result: 'review text' });
    expect(tool.parseTokenUsage!(json)).toBe(0);
  });

  it('returns 0 when output is not JSON', () => {
    const tool = getToolCommand('claude-code');
    expect(tool.parseTokenUsage!('plain text')).toBe(0);
  });
});

describe('executeTool', () => {
  const mockSpawn = vi.mocked(spawn);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pipes prompt via stdin and resolves on success', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('codex', 'Review this code', 60_000);

    // Verify spawn was called without prompt in args
    expect(mockSpawn).toHaveBeenCalledWith('codex', ['exec'], expect.any(Object));

    emitOutput(child, { stdout: 'VERDICT: APPROVE\nLGTM', code: 0 });

    const result = await promise;
    expect(result.stdout).toBe('VERDICT: APPROVE\nLGTM');
    expect(result.tokensUsed).toBe(0);
  });

  it('captures stderr alongside stdout', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('codex', 'test', 60_000);

    emitOutput(child, { stdout: 'output', stderr: 'some warning', code: 0 });

    const result = await promise;
    expect(result.stdout).toBe('output');
    expect(result.stderr).toBe('some warning');
  });

  it('writes prompt to stdin', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const prompt = 'Please review this code carefully';
    const promise = executeTool('codex', prompt, 60_000);

    // Verify stdin was written to with the prompt
    expect(child.stdin.write).toHaveBeenCalledWith(prompt);
    expect(child.stdin.end).toHaveBeenCalled();

    emitOutput(child, { stdout: 'result', code: 0 });

    await promise;
  });

  it('handles large prompts via stdin (>100KB)', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const largePrompt = 'x'.repeat(150 * 1024); // 150KB
    const promise = executeTool('codex', largePrompt, 60_000);

    expect(child.stdin.write).toHaveBeenCalledWith(largePrompt);

    emitOutput(child, { stdout: 'review output', code: 0 });

    const result = await promise;
    expect(result.stdout).toBe('review output');
  });

  it('treats non-zero exit with meaningful stdout as partial success', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const promise = executeTool('codex', 'test', 60_000);

    emitOutput(child, {
      stdout: 'VERDICT: APPROVE\nPartial review output that is long enough',
      stderr: 'rate limit warning',
      code: 1,
    });

    const result = await promise;
    expect(result.stdout).toContain('VERDICT: APPROVE');
    expect(result.stderr).toBe('rate limit warning');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exited with code 1'));

    warnSpy.mockRestore();
  });

  it('rejects on non-zero exit with no meaningful stdout', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('codex', 'test', 60_000);

    emitOutput(child, { stderr: 'command not found', code: 127 });

    await expect(promise).rejects.toThrow(/failed.*exit code 127.*command not found/i);
  });

  it('rejects on non-zero exit with short stdout', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('codex', 'test', 60_000);

    emitOutput(child, { stdout: 'err', code: 1 });

    await expect(promise).rejects.toThrow(/failed with exit code 1/);
  });

  it('throws ToolTimeoutError when process is killed with SIGTERM', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('codex', 'test', 30_000);

    emitOutput(child, { code: null, signal: 'SIGTERM' });

    await expect(promise).rejects.toThrow(ToolTimeoutError);
    await expect(promise).rejects.toThrow(/timed out/);
  });

  it('throws ToolTimeoutError when process is killed with SIGKILL', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('codex', 'test', 30_000);

    emitOutput(child, { code: null, signal: 'SIGKILL' });

    await expect(promise).rejects.toThrow(ToolTimeoutError);
  });

  it('throws UnsupportedToolError for unknown tool', () => {
    expect(() => executeTool('nonexistent', 'test', 30_000)).toThrow(UnsupportedToolError);
  });

  it('rejects immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(executeTool('codex', 'test', 30_000, controller.signal)).rejects.toThrow(
      ToolTimeoutError,
    );
  });

  it('kills child process when signal is aborted', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const controller = new AbortController();
    const promise = executeTool('codex', 'test', 60_000, controller.signal);

    // Abort the signal
    controller.abort();
    expect(child.kill).toHaveBeenCalled();

    // Simulate the process closing after kill
    emitOutput(child, { code: null, signal: 'SIGTERM' });

    await expect(promise).rejects.toThrow(ToolTimeoutError);
  });

  it('extracts text from claude-code JSON output', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('claude-code', 'Review this', 60_000);

    const jsonOutput = JSON.stringify({
      result: 'VERDICT: APPROVE\nLooks great!',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    emitOutput(child, { stdout: jsonOutput, code: 0 });

    const result = await promise;
    expect(result.stdout).toBe('VERDICT: APPROVE\nLooks great!');
    expect(result.tokensUsed).toBe(150);
  });

  it('falls back to raw output if claude-code JSON parsing fails', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('claude-code', 'Review this', 60_000);

    emitOutput(child, { stdout: 'VERDICT: APPROVE\nPlain text fallback', code: 0 });

    const result = await promise;
    expect(result.stdout).toBe('VERDICT: APPROVE\nPlain text fallback');
    expect(result.tokensUsed).toBe(0);
  });

  it('propagates spawn error events', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('codex', 'test', 30_000);

    child.emit('error', new Error('ENOENT: command not found'));

    await expect(promise).rejects.toThrow('ENOENT: command not found');
  });

  it('includes stderr in error message on failure', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('codex', 'test', 60_000);

    emitOutput(child, { stderr: 'Error: authentication failed', code: 1 });

    await expect(promise).rejects.toThrow(/authentication failed/);
  });
});
