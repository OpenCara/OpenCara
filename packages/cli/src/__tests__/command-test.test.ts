import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testCommand } from '../tool-executor.js';

import EventEmitter from 'node:events';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

function createMockChild() {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  const stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };

  Object.assign(child, { stdin, stdout, stderr, kill: vi.fn(), pid: 99 });

  return child as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
}

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

describe('testCommand', () => {
  const mockSpawn = vi.mocked(spawn);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok on successful command execution', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = testCommand('echo test');

    emitOutput(child, { stdout: 'OK', code: 0 });

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('sends test prompt via stdin', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = testCommand('my-tool');

    expect(child.stdin.write).toHaveBeenCalledWith('Respond with: OK');
    expect(child.stdin.end).toHaveBeenCalled();

    emitOutput(child, { stdout: 'OK', code: 0 });
    await promise;
  });

  it('returns failure with error message on non-zero exit', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = testCommand('bad-tool');

    emitOutput(child, { stderr: 'Error: bad API key', code: 1 });

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('bad API key');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('returns failure on timeout without throwing', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = testCommand('slow-tool');

    // executeTool maps SIGTERM close to ToolTimeoutError (its own timer sends SIGTERM)
    emitOutput(child, { code: null, signal: 'SIGTERM' });

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('uses default 10s timeout when no timeoutMs specified', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = testCommand('slow-tool');

    emitOutput(child, { code: null, signal: 'SIGTERM' });

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('command timed out after 10s');
  });

  it('uses custom timeout when timeoutMs is provided', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = testCommand('slow-tool', 30_000);

    emitOutput(child, { code: null, signal: 'SIGTERM' });

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('command timed out after 30s');
  });

  it('uses custom timeout of 60s (1m) when provided', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = testCommand('slow-tool', 60_000);

    emitOutput(child, { code: null, signal: 'SIGTERM' });

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('command timed out after 60s');
  });

  it('returns failure on spawn error without throwing', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = testCommand('nonexistent-tool');

    child.emit('error', new Error('ENOENT: command not found'));

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  it('never throws regardless of failure type', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = testCommand('failing-tool');

    emitOutput(child, { stderr: 'fatal error', code: 127 });

    // Should resolve (not reject)
    await expect(promise).resolves.toBeDefined();
  });
});
