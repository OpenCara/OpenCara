import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerShutdownHandlers } from '../commands/agent.js';

// Prevent actual process.exit in tests
const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

// Mock child_process (required by agent.ts import chain)
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error) => void) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      if (callback) {
        const err = new Error('gh not available in test');
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        process.nextTick(() => callback(err));
      }
      return { pid: 0, kill: () => false };
    }),
  };
});

vi.mock('../repo-cache.js', () => ({
  checkoutWorktree: vi.fn(),
  cleanupWorktree: vi.fn(),
  getRepoSize: vi.fn().mockReturnValue(0),
  parseDiffPaths: vi.fn().mockReturnValue([]),
}));

vi.mock('../tool-executor.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    testCommand: vi.fn().mockResolvedValue({ ok: true, elapsedMs: 150 }),
    executeTool: vi.fn().mockResolvedValue({
      stdout: 'test',
      stderr: '',
      exitCode: 0,
      tokensUsed: 0,
      tokensParsed: false,
      tokenDetail: { input: 0, output: 0, total: 0, parsed: false },
    }),
  };
});

describe('registerShutdownHandlers', () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    exitSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Always remove listeners registered during the test
    cleanup?.();
    cleanup = undefined;
  });

  it('aborts controller on SIGTERM', () => {
    const controller = new AbortController();
    const log = vi.fn();
    cleanup = registerShutdownHandlers(controller, log);

    process.emit('SIGTERM');

    expect(controller.signal.aborted).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('SIGTERM'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('shutting down gracefully'));
  });

  it('aborts controller on SIGINT', () => {
    const controller = new AbortController();
    const log = vi.fn();
    cleanup = registerShutdownHandlers(controller, log);

    process.emit('SIGINT');

    expect(controller.signal.aborted).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('SIGINT'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('shutting down gracefully'));
  });

  it('force-exits after grace period timeout', () => {
    const controller = new AbortController();
    const log = vi.fn();
    cleanup = registerShutdownHandlers(controller, log, 3000);

    process.emit('SIGTERM');
    expect(exitSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3000);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  it('force-exits immediately on second signal', () => {
    const controller = new AbortController();
    const log = vi.fn();
    cleanup = registerShutdownHandlers(controller, log);

    process.emit('SIGTERM');
    expect(exitSpy).not.toHaveBeenCalled();

    // Second signal — immediate exit
    process.emit('SIGINT');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('forcing exit'));
  });

  it('does not force-exit before grace period expires', () => {
    const controller = new AbortController();
    const log = vi.fn();
    cleanup = registerShutdownHandlers(controller, log, 5000);

    process.emit('SIGTERM');
    expect(exitSpy).not.toHaveBeenCalled();

    // Advance partway through grace period — should not exit yet
    vi.advanceTimersByTime(4999);
    expect(exitSpy).not.toHaveBeenCalled();

    // Advance past grace period — force exit fires
    vi.advanceTimersByTime(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('removes listeners when cleanup function is called', () => {
    const controller = new AbortController();
    const log = vi.fn();
    cleanup = registerShutdownHandlers(controller, log);

    const countBefore = process.listenerCount('SIGTERM');
    const countBeforeInt = process.listenerCount('SIGINT');

    // Remove listeners
    cleanup();
    cleanup = undefined;

    // Verify listener count decreased
    expect(process.listenerCount('SIGTERM')).toBe(countBefore - 1);
    expect(process.listenerCount('SIGINT')).toBe(countBeforeInt - 1);
    // Controller should not have been aborted
    expect(controller.signal.aborted).toBe(false);
  });

  it('clears force timer when cleanup is called after signal', () => {
    const controller = new AbortController();
    const log = vi.fn();
    cleanup = registerShutdownHandlers(controller, log, 5000);

    // Trigger signal — starts the force timer
    process.emit('SIGTERM');
    expect(controller.signal.aborted).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();

    // Cleanup should clear the force timer
    cleanup();
    cleanup = undefined;

    // Advance past grace period — timer should have been cleared
    vi.advanceTimersByTime(10000);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
