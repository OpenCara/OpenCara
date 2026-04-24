import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  executeTool,
  parseCommandTemplate,
  resolveCommandTemplate,
  parseTokenUsage,
  estimateTokens,
  ToolTimeoutError,
  SIGKILL_GRACE_MS,
  STDOUT_LIVENESS_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
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
    expect(() => resolveCommandTemplate(null)).toThrow(/config\.toml/);
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

  it('populates CODEBASE_DIR from cwd for backward compatibility', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool(
      'claude --cwd ${CODEBASE_DIR} --print',
      'test',
      60_000,
      undefined,
      undefined,
      '/tmp/repos/acme/widgets',
    );

    // CODEBASE_DIR should be interpolated from the cwd value
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['--cwd', '/tmp/repos/acme/widgets', '--print'],
      expect.objectContaining({ cwd: '/tmp/repos/acme/widgets' }),
    );

    emitOutput(child, { stdout: 'result', code: 0 });
    await promise;
  });

  it('respects explicit CODEBASE_DIR in vars over cwd', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool(
      'claude --cwd ${CODEBASE_DIR} --print',
      'test',
      60_000,
      undefined,
      { CODEBASE_DIR: '/explicit/path' },
      '/tmp/repos/acme/widgets',
    );

    // Explicit vars CODEBASE_DIR should take precedence over cwd
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['--cwd', '/explicit/path', '--print'],
      expect.objectContaining({ cwd: '/tmp/repos/acme/widgets' }),
    );

    emitOutput(child, { stdout: 'result', code: 0 });
    await promise;
  });

  it('passes cwd to spawn options', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = executeTool('codex exec', 'test', 60_000, undefined, undefined, '/some/dir');

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['exec'],
      expect.objectContaining({ cwd: '/some/dir' }),
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

  describe('SIGKILL escalation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sends SIGKILL after grace period if process ignores SIGTERM on timeout', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const timeoutMs = 10_000;
      const promise = executeTool('stubborn-tool', 'test', timeoutMs);

      // Advance past timeout — SIGTERM fires
      vi.advanceTimersByTime(timeoutMs);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

      // Advance past SIGKILL grace period — process still alive
      vi.advanceTimersByTime(SIGKILL_GRACE_MS);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');

      // Process finally exits with SIGKILL
      emitOutput(child, { code: null, signal: 'SIGKILL' });

      await expect(promise).rejects.toThrow(ToolTimeoutError);
    });

    it('does not send SIGKILL if process exits after SIGTERM', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const timeoutMs = 10_000;
      const promise = executeTool('good-tool', 'test', timeoutMs);

      // Advance past timeout — SIGTERM fires
      vi.advanceTimersByTime(timeoutMs);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      // Process exits promptly after SIGTERM (before grace period)
      emitOutput(child, { code: null, signal: 'SIGTERM' });

      await expect(promise).rejects.toThrow(ToolTimeoutError);

      // Advance past grace period — SIGKILL should NOT be sent because cleanup cleared it
      vi.advanceTimersByTime(SIGKILL_GRACE_MS);
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    });

    it('sends SIGKILL after grace period when abort signal fires', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const controller = new AbortController();
      const promise = executeTool('stubborn-tool', 'test', 60_000, controller.signal);

      // Abort the signal — SIGTERM fires
      controller.abort();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

      // Advance past SIGKILL grace period — process still alive
      vi.advanceTimersByTime(SIGKILL_GRACE_MS);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');

      // Process finally exits with SIGKILL
      emitOutput(child, { code: null, signal: 'SIGKILL' });

      await expect(promise).rejects.toThrow(ToolTimeoutError);
    });

    it('clears SIGKILL timer if process exits after abort SIGTERM', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const controller = new AbortController();
      const promise = executeTool('good-tool', 'test', 60_000, controller.signal);

      // Abort the signal — SIGTERM fires
      controller.abort();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      // Process exits promptly
      emitOutput(child, { code: null, signal: 'SIGTERM' });

      await expect(promise).rejects.toThrow(ToolTimeoutError);

      // Advance past grace period — SIGKILL should NOT be sent
      vi.advanceTimersByTime(SIGKILL_GRACE_MS);
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    });
  });

  describe('stdout liveness timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('kills process when no stdout for livenessTimeoutMs', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const livenessMs = 30_000;
      const promise = executeTool(
        'stuck-tool',
        'test',
        600_000,
        undefined,
        undefined,
        undefined,
        livenessMs,
      );

      // Advance past liveness timeout — SIGTERM fires
      vi.advanceTimersByTime(livenessMs);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      // Process exits with SIGTERM
      emitOutput(child, { code: null, signal: 'SIGTERM' });

      await expect(promise).rejects.toThrow(ToolTimeoutError);
      await expect(promise).rejects.toThrow(/no stdout for 30s/);
    });

    it('resets liveness timer on stdout data', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const livenessMs = 30_000;
      const promise = executeTool(
        'alive-tool',
        'test',
        600_000,
        undefined,
        undefined,
        undefined,
        livenessMs,
      );

      // Advance 20s (before liveness fires)
      vi.advanceTimersByTime(20_000);
      expect(child.kill).not.toHaveBeenCalled();

      // Emit stdout — resets timer
      child.stdout.emit('data', Buffer.from('partial output'));

      // Advance another 20s (40s total, but only 20s since last stdout)
      vi.advanceTimersByTime(20_000);
      expect(child.kill).not.toHaveBeenCalled();

      // Advance past the reset liveness window (30s since last stdout)
      vi.advanceTimersByTime(10_000);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      emitOutput(child, { code: null, signal: 'SIGTERM' });
      await expect(promise).rejects.toThrow(ToolTimeoutError);
    });

    it('does NOT reset liveness timer on stderr-only data', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const livenessMs = 30_000;
      const promise = executeTool(
        'stderr-tool',
        'test',
        600_000,
        undefined,
        undefined,
        undefined,
        livenessMs,
      );

      // Advance 20s
      vi.advanceTimersByTime(20_000);
      expect(child.kill).not.toHaveBeenCalled();

      // Emit stderr only — should NOT reset liveness
      child.stderr.emit('data', Buffer.from('retrying... 429'));

      // Advance past original liveness window
      vi.advanceTimersByTime(10_000);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      emitOutput(child, { code: null, signal: 'SIGTERM' });
      await expect(promise).rejects.toThrow(/no stdout for 30s/);
    });

    it('uses default liveness timeout when not specified', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      // No livenessTimeoutMs arg — uses STDOUT_LIVENESS_TIMEOUT_MS default
      const promise = executeTool('default-tool', 'test', 600_000);

      // Advance past default liveness
      vi.advanceTimersByTime(STDOUT_LIVENESS_TIMEOUT_MS);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      emitOutput(child, { code: null, signal: 'SIGTERM' });
      await expect(promise).rejects.toThrow(/no stdout for 300s/);
    });

    it('disabled when livenessTimeoutMs is 0', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const promise = executeTool(
        'no-liveness',
        'test',
        600_000,
        undefined,
        undefined,
        undefined,
        0,
      );

      // Advance past default liveness — should NOT kill
      vi.advanceTimersByTime(STDOUT_LIVENESS_TIMEOUT_MS + 10_000);
      expect(child.kill).not.toHaveBeenCalled();

      // Complete normally
      emitOutput(child, { stdout: 'done', code: 0 });
      const result = await promise;
      expect(result.stdout).toBe('done');
    });

    it('liveness fires before main timeout', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const mainTimeout = 600_000;
      const livenessMs = 30_000;
      const promise = executeTool(
        'stuck-tool',
        'test',
        mainTimeout,
        undefined,
        undefined,
        undefined,
        livenessMs,
      );

      // Advance past liveness (well before main timeout)
      vi.advanceTimersByTime(livenessMs);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      emitOutput(child, { code: null, signal: 'SIGTERM' });

      // Should report liveness kill, not main timeout
      await expect(promise).rejects.toThrow(/no stdout for 30s/);
      await expect(promise).rejects.not.toThrow(/timed out after/);
    });

    it('coexists with main timeout — main fires when liveness is reset', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const mainTimeout = 60_000;
      const livenessMs = 30_000;
      const promise = executeTool(
        'slow-tool',
        'test',
        mainTimeout,
        undefined,
        undefined,
        undefined,
        livenessMs,
      );

      // Keep resetting liveness with stdout every 20s
      vi.advanceTimersByTime(20_000);
      child.stdout.emit('data', Buffer.from('chunk1'));
      vi.advanceTimersByTime(20_000);
      child.stdout.emit('data', Buffer.from('chunk2'));

      // Now at 40s — advance past main timeout (60s)
      vi.advanceTimersByTime(20_000);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      emitOutput(child, { code: null, signal: 'SIGTERM' });

      // Should report main timeout, not liveness
      await expect(promise).rejects.toThrow(/timed out after 60s/);
    });
  });

  describe('heartbeat', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('fires callback on the configured interval while the tool is running', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const heartbeat = vi.fn();
      const intervalMs = 60_000;
      const promise = executeTool(
        'long-tool',
        'test',
        600_000,
        undefined,
        undefined,
        undefined,
        0, // disable liveness to isolate heartbeat behavior
        { callback: heartbeat, intervalMs },
      );

      // No ticks have fired yet
      expect(heartbeat).not.toHaveBeenCalled();

      // Tick 1
      vi.advanceTimersByTime(intervalMs);
      expect(heartbeat).toHaveBeenCalledTimes(1);

      // Tick 2
      vi.advanceTimersByTime(intervalMs);
      expect(heartbeat).toHaveBeenCalledTimes(2);

      // Tick 3
      vi.advanceTimersByTime(intervalMs);
      expect(heartbeat).toHaveBeenCalledTimes(3);

      // Finish the tool — interval must stop firing
      emitOutput(child, { stdout: 'done', code: 0 });
      await promise;

      // Advance further — NO more heartbeats after tool exit
      vi.advanceTimersByTime(intervalMs * 5);
      expect(heartbeat).toHaveBeenCalledTimes(3);
    });

    it('uses DEFAULT_HEARTBEAT_INTERVAL_MS when intervalMs is omitted', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const heartbeat = vi.fn();
      const promise = executeTool(
        'long-tool',
        'test',
        600_000,
        undefined,
        undefined,
        undefined,
        0,
        { callback: heartbeat },
      );

      vi.advanceTimersByTime(DEFAULT_HEARTBEAT_INTERVAL_MS - 1);
      expect(heartbeat).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(heartbeat).toHaveBeenCalledTimes(1);

      emitOutput(child, { stdout: 'done', code: 0 });
      await promise;
    });

    it('is a no-op when no heartbeat is supplied', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const promise = executeTool(
        'quiet-tool',
        'test',
        600_000,
        undefined,
        undefined,
        undefined,
        0,
      );

      // No heartbeat config — just advance time and confirm nothing throws
      vi.advanceTimersByTime(DEFAULT_HEARTBEAT_INTERVAL_MS * 3);

      emitOutput(child, { stdout: 'done', code: 0 });
      const result = await promise;
      expect(result.stdout).toBe('done');
    });

    it('is disabled when intervalMs is 0', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const heartbeat = vi.fn();
      const promise = executeTool(
        'long-tool',
        'test',
        600_000,
        undefined,
        undefined,
        undefined,
        0,
        { callback: heartbeat, intervalMs: 0 },
      );

      vi.advanceTimersByTime(DEFAULT_HEARTBEAT_INTERVAL_MS * 5);
      expect(heartbeat).not.toHaveBeenCalled();

      emitOutput(child, { stdout: 'done', code: 0 });
      await promise;
    });

    it('stops firing after the tool exits with an error', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const heartbeat = vi.fn();
      const intervalMs = 60_000;
      const promise = executeTool(
        'broken-tool',
        'test',
        600_000,
        undefined,
        undefined,
        undefined,
        0,
        { callback: heartbeat, intervalMs },
      );

      vi.advanceTimersByTime(intervalMs);
      expect(heartbeat).toHaveBeenCalledTimes(1);

      // Simulate tool crash
      child.emit('error', new Error('ENOENT: tool missing'));
      await expect(promise).rejects.toThrow('ENOENT');

      // Advance further — interval must be cleared
      vi.advanceTimersByTime(intervalMs * 3);
      expect(heartbeat).toHaveBeenCalledTimes(1);
    });

    it('stops firing after the tool is killed by timeout', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const heartbeat = vi.fn();
      const intervalMs = 60_000;
      const timeoutMs = 30_000;
      const promise = executeTool(
        'stuck-tool',
        'test',
        timeoutMs,
        undefined,
        undefined,
        undefined,
        0,
        { callback: heartbeat, intervalMs },
      );

      // Timeout fires before first heartbeat (interval > timeout)
      vi.advanceTimersByTime(timeoutMs);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(heartbeat).not.toHaveBeenCalled();

      emitOutput(child, { code: null, signal: 'SIGTERM' });
      await expect(promise).rejects.toThrow(ToolTimeoutError);

      // Advance past interval — interval must be cleared
      vi.advanceTimersByTime(intervalMs * 3);
      expect(heartbeat).not.toHaveBeenCalled();
    });

    it('stops firing after the abort signal is triggered', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const heartbeat = vi.fn();
      const intervalMs = 60_000;
      const controller = new AbortController();
      const promise = executeTool(
        'long-tool',
        'test',
        600_000,
        controller.signal,
        undefined,
        undefined,
        0,
        { callback: heartbeat, intervalMs },
      );

      vi.advanceTimersByTime(intervalMs);
      expect(heartbeat).toHaveBeenCalledTimes(1);

      controller.abort();
      emitOutput(child, { code: null, signal: 'SIGTERM' });
      await expect(promise).rejects.toThrow(ToolTimeoutError);

      // Advance further — interval must be cleared
      vi.advanceTimersByTime(intervalMs * 3);
      expect(heartbeat).toHaveBeenCalledTimes(1);
    });

    it('swallows synchronous errors thrown from the callback without killing the tool', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const heartbeat = vi.fn(() => {
        throw new Error('boom');
      });
      const intervalMs = 60_000;
      const promise = executeTool(
        'long-tool',
        'test',
        600_000,
        undefined,
        undefined,
        undefined,
        0,
        { callback: heartbeat, intervalMs },
      );

      // Multiple ticks — each throws, but the tool keeps running and the
      // interval keeps firing.
      vi.advanceTimersByTime(intervalMs);
      vi.advanceTimersByTime(intervalMs);
      vi.advanceTimersByTime(intervalMs);
      expect(heartbeat).toHaveBeenCalledTimes(3);
      expect(child.kill).not.toHaveBeenCalled();

      emitOutput(child, { stdout: 'still works', code: 0 });
      const result = await promise;
      expect(result.stdout).toBe('still works');
    });

    it('swallows rejected promises from the callback without killing the tool', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const heartbeat = vi.fn(async () => {
        throw new Error('network blip');
      });
      const intervalMs = 60_000;
      const promise = executeTool(
        'long-tool',
        'test',
        600_000,
        undefined,
        undefined,
        undefined,
        0,
        { callback: heartbeat, intervalMs },
      );

      // Fire two ticks — each returns a rejected promise. The executor must
      // attach a .catch so the unhandled rejection does not propagate.
      vi.advanceTimersByTime(intervalMs);
      vi.advanceTimersByTime(intervalMs);
      // Let the pending microtasks (the .catch handlers) settle.
      await Promise.resolve();
      await Promise.resolve();

      expect(heartbeat).toHaveBeenCalledTimes(2);
      expect(child.kill).not.toHaveBeenCalled();

      emitOutput(child, { stdout: 'ok', code: 0 });
      const result = await promise;
      expect(result.stdout).toBe('ok');
    });

    it('coexists with the liveness timer', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const heartbeat = vi.fn();
      const intervalMs = 30_000;
      const livenessMs = 60_000;
      const promise = executeTool(
        'long-tool',
        'test',
        600_000,
        undefined,
        undefined,
        undefined,
        livenessMs,
        { callback: heartbeat, intervalMs },
      );

      vi.advanceTimersByTime(intervalMs);
      child.stdout.emit('data', Buffer.from('progress'));
      expect(heartbeat).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(intervalMs);
      child.stdout.emit('data', Buffer.from('more progress'));
      expect(heartbeat).toHaveBeenCalledTimes(2);

      // Tool exits cleanly — both timers must be cleared
      emitOutput(child, { stdout: 'done', code: 0 });
      await promise;

      vi.advanceTimersByTime(intervalMs * 5 + livenessMs);
      expect(heartbeat).toHaveBeenCalledTimes(2);
      expect(child.kill).not.toHaveBeenCalled();
    });
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
    expect(parseTokenUsage(stdout, '')).toEqual({
      tokens: 1801,
      parsed: true,
      input: 0,
      output: 1801,
    });
  });

  it('parses Codex "tokens used" without comma', () => {
    const stdout = 'Output\ntokens used 275';
    expect(parseTokenUsage(stdout, '')).toEqual({
      tokens: 275,
      parsed: true,
      input: 0,
      output: 275,
    });
  });

  it('parses Claude JSON usage from stdout', () => {
    const stdout = '{"result":"ok","usage":{"input_tokens":1234,"output_tokens":567}}';
    expect(parseTokenUsage(stdout, '')).toEqual({
      tokens: 1801,
      parsed: true,
      input: 1234,
      output: 567,
    });
  });

  it('parses Claude JSON with output_tokens before input_tokens', () => {
    const stdout = '{"usage":{"output_tokens":567,"input_tokens":1234}}';
    expect(parseTokenUsage(stdout, '')).toEqual({
      tokens: 1801,
      parsed: true,
      input: 1234,
      output: 567,
    });
  });

  it('parses Claude JSON usage from stderr', () => {
    const stderr = '{"input_tokens": 500, "output_tokens": 200}';
    expect(parseTokenUsage('plain text output', stderr)).toEqual({
      tokens: 700,
      parsed: true,
      input: 500,
      output: 200,
    });
  });

  it('parses Qwen JSON stats', () => {
    const stdout = '{"stats":{"models":{"qwen":{"tokens":{"total":3500}}}}}';
    expect(parseTokenUsage(stdout, '')).toEqual({
      tokens: 3500,
      parsed: true,
      input: 0,
      output: 3500,
    });
  });

  it('falls back to character estimate when no pattern matches', () => {
    const stdout = 'Just a plain review with no token info';
    const estimated = Math.ceil(stdout.length / 4);
    expect(parseTokenUsage(stdout, '')).toEqual({
      tokens: estimated,
      parsed: false,
      input: 0,
      output: estimated,
    });
  });

  it('returns 0 for empty output', () => {
    expect(parseTokenUsage('', '')).toEqual({
      tokens: 0,
      parsed: false,
      input: 0,
      output: 0,
    });
  });
});
