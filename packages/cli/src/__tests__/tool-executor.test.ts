import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  executeTool,
  parseCommandTemplate,
  resolveCommandTemplate,
  parseTokenUsage,
  estimateTokens,
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

describe('parseCommandTemplate', () => {
  it('splits simple command into command and args', () => {
    const result = parseCommandTemplate('claude -p --output-format text');
    expect(result).toEqual({
      command: 'claude',
      args: ['-p', '--output-format', 'text'],
    });
  });

  it('handles command with no args', () => {
    const result = parseCommandTemplate('my-script');
    expect(result).toEqual({ command: 'my-script', args: [] });
  });

  it('handles double-quoted arguments', () => {
    const result = parseCommandTemplate('cmd --flag "hello world" --other');
    expect(result).toEqual({
      command: 'cmd',
      args: ['--flag', 'hello world', '--other'],
    });
  });

  it('handles single-quoted arguments', () => {
    const result = parseCommandTemplate("cmd 'hello world'");
    expect(result).toEqual({
      command: 'cmd',
      args: ['hello world'],
    });
  });

  it('interpolates ${TOOL} variable', () => {
    const result = parseCommandTemplate('ollama run ${TOOL}', { TOOL: 'claude-code' });
    expect(result).toEqual({
      command: 'ollama',
      args: ['run', 'claude-code'],
    });
  });

  it('interpolates ${MODEL} variable', () => {
    const result = parseCommandTemplate('claude -p --model ${MODEL}', {
      MODEL: 'claude-sonnet-4-6',
    });
    expect(result).toEqual({
      command: 'claude',
      args: ['-p', '--model', 'claude-sonnet-4-6'],
    });
  });

  it('interpolates multiple variables', () => {
    const result = parseCommandTemplate('tool --model ${MODEL} --via ${TOOL}', {
      MODEL: 'gpt-4',
      TOOL: 'custom',
    });
    expect(result).toEqual({
      command: 'tool',
      args: ['--model', 'gpt-4', '--via', 'custom'],
    });
  });

  it('leaves unmatched variables as-is', () => {
    const result = parseCommandTemplate('cmd ${UNKNOWN}', {});
    expect(result).toEqual({
      command: 'cmd',
      args: ['${UNKNOWN}'],
    });
  });

  it('handles extra whitespace', () => {
    const result = parseCommandTemplate('  cmd   arg1   arg2  ');
    expect(result).toEqual({ command: 'cmd', args: ['arg1', 'arg2'] });
  });

  it('throws on empty template', () => {
    expect(() => parseCommandTemplate('')).toThrow('Empty command template');
  });

  it('throws on whitespace-only template', () => {
    expect(() => parseCommandTemplate('   ')).toThrow('Empty command template');
  });

  it('handles absolute paths as command', () => {
    const result = parseCommandTemplate('/home/user/my-review-tool.sh --flag');
    expect(result).toEqual({
      command: '/home/user/my-review-tool.sh',
      args: ['--flag'],
    });
  });
});

describe('resolveCommandTemplate', () => {
  it('returns explicit agentCommand when provided', () => {
    const result = resolveCommandTemplate('my-custom-tool --flag');
    expect(result).toBe('my-custom-tool --flag');
  });

  it('throws when no command configured', () => {
    expect(() => resolveCommandTemplate(null)).toThrow(/No command configured/);
    expect(() => resolveCommandTemplate(undefined)).toThrow(/No command configured/);
  });

  it('throws with helpful message mentioning config', () => {
    expect(() => resolveCommandTemplate(null)).toThrow(/config\.yml/);
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

    const promise = executeTool('codex exec', 'Review this code', 60_000);

    // Verify spawn was called with parsed command template
    expect(mockSpawn).toHaveBeenCalledWith('codex', ['exec'], expect.any(Object));

    emitOutput(child, { stdout: 'VERDICT: APPROVE\nLGTM', code: 0 });

    const result = await promise;
    expect(result.stdout).toBe('VERDICT: APPROVE\nLGTM');
    // Estimated from output length: ceil(24 / 4) = 6
    expect(result.tokensUsed).toBeGreaterThan(0);
  });

  it('captures stderr alongside stdout', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('codex exec', 'test', 60_000);

    emitOutput(child, { stdout: 'output', stderr: 'some warning', code: 0 });

    const result = await promise;
    expect(result.stdout).toBe('output');
    expect(result.stderr).toBe('some warning');
  });

  it('writes prompt to stdin', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const prompt = 'Please review this code carefully';
    const promise = executeTool('codex exec', prompt, 60_000);

    expect(child.stdin.write).toHaveBeenCalledWith(prompt);
    expect(child.stdin.end).toHaveBeenCalled();

    emitOutput(child, { stdout: 'result', code: 0 });

    await promise;
  });

  it('handles large prompts via stdin (>100KB)', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const largePrompt = 'x'.repeat(150 * 1024); // 150KB
    const promise = executeTool('codex exec', largePrompt, 60_000);

    expect(child.stdin.write).toHaveBeenCalledWith(largePrompt);

    emitOutput(child, { stdout: 'review output', code: 0 });

    const result = await promise;
    expect(result.stdout).toBe('review output');
  });

  it('treats non-zero exit with meaningful stdout as partial success', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const promise = executeTool('codex exec', 'test', 60_000);

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

    const promise = executeTool('codex exec', 'test', 60_000);

    emitOutput(child, { stderr: 'command not found', code: 127 });

    await expect(promise).rejects.toThrow(/failed.*exit code 127.*command not found/i);
  });

  it('rejects on non-zero exit with short stdout', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('codex exec', 'test', 60_000);

    emitOutput(child, { stdout: 'err', code: 1 });

    await expect(promise).rejects.toThrow(/failed with exit code 1/);
  });

  it('throws ToolTimeoutError when process is killed with SIGTERM', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('codex exec', 'test', 30_000);

    emitOutput(child, { code: null, signal: 'SIGTERM' });

    await expect(promise).rejects.toThrow(ToolTimeoutError);
    await expect(promise).rejects.toThrow(/timed out/);
  });

  it('throws ToolTimeoutError when process is killed with SIGKILL', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('codex exec', 'test', 30_000);

    emitOutput(child, { code: null, signal: 'SIGKILL' });

    await expect(promise).rejects.toThrow(ToolTimeoutError);
  });

  it('rejects immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(executeTool('codex exec', 'test', 30_000, controller.signal)).rejects.toThrow(
      ToolTimeoutError,
    );
  });

  it('kills child process when signal is aborted', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const controller = new AbortController();
    const promise = executeTool('codex exec', 'test', 60_000, controller.signal);

    controller.abort();
    expect(child.kill).toHaveBeenCalled();

    emitOutput(child, { code: null, signal: 'SIGTERM' });

    await expect(promise).rejects.toThrow(ToolTimeoutError);
  });

  it('propagates spawn error events', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('codex exec', 'test', 30_000);

    child.emit('error', new Error('ENOENT: command not found'));

    await expect(promise).rejects.toThrow('ENOENT: command not found');
  });

  it('includes stderr in error message on failure', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('codex exec', 'test', 60_000);

    emitOutput(child, { stderr: 'Error: authentication failed', code: 1 });

    await expect(promise).rejects.toThrow(/authentication failed/);
  });

  it('interpolates vars when provided', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('claude -p --model ${MODEL}', 'test', 60_000, undefined, {
      MODEL: 'claude-sonnet-4-6',
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['-p', '--model', 'claude-sonnet-4-6'],
      expect.any(Object),
    );

    emitOutput(child, { stdout: 'result', code: 0 });
    await promise;
  });

  it('uses custom command templates', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('/home/user/my-review-tool.sh', 'review this', 60_000);

    expect(mockSpawn).toHaveBeenCalledWith('/home/user/my-review-tool.sh', [], expect.any(Object));

    emitOutput(child, { stdout: 'VERDICT: APPROVE\nAll good', code: 0 });

    const result = await promise;
    expect(result.stdout).toBe('VERDICT: APPROVE\nAll good');
  });
});

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('abc')).toBe(1); // ceil(3/4) = 1
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('parseTokenUsage', () => {
  it('parses Codex "tokens used" footer', () => {
    const stdout = 'Some review output\n\ntokens used 1,801';
    expect(parseTokenUsage(stdout, '')).toBe(1801);
  });

  it('parses Codex "tokens used" without comma', () => {
    const stdout = 'Output\ntokens used 275';
    expect(parseTokenUsage(stdout, '')).toBe(275);
  });

  it('parses Claude JSON usage from stdout', () => {
    const stdout = '{"result":"ok","usage":{"input_tokens":1234,"output_tokens":567}}';
    expect(parseTokenUsage(stdout, '')).toBe(1801);
  });

  it('parses Claude JSON usage from stderr', () => {
    const stderr = '{"input_tokens": 500, "output_tokens": 200}';
    expect(parseTokenUsage('plain text output', stderr)).toBe(700);
  });

  it('parses Qwen JSON stats', () => {
    const stdout = '{"stats":{"models":{"qwen":{"tokens":{"total":3500}}}}}';
    expect(parseTokenUsage(stdout, '')).toBe(3500);
  });

  it('falls back to character estimate when no pattern matches', () => {
    const stdout = 'Just a plain review with no token info';
    expect(parseTokenUsage(stdout, '')).toBe(Math.ceil(stdout.length / 4));
  });

  it('returns 0 for empty output', () => {
    expect(parseTokenUsage('', '')).toBe(0);
  });
});
