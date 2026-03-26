/**
 * Tests for fetchDiffViaGh — the gh CLI diff fetch path.
 *
 * Covers:
 * - Successful gh API call returns diff content
 * - gh CLI failure (not installed, not authenticated) returns null
 * - gh CLI error (non-zero exit) returns null
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';

// ── Mock child_process ──────────────────────────────────────

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

// Must also mock tool-executor since agent.ts imports it
vi.mock('../tool-executor.js', () => ({
  executeTool: vi.fn(),
  estimateTokens: (text: string) => Math.ceil(text.length / 4),
  validateCommandBinary: vi.fn(() => true),
  parseCommandTemplate: (cmd: string) => cmd.split(' '),
  testCommand: vi.fn(async () => ({ ok: true, elapsedMs: 100 })),
}));

import { fetchDiffViaGh } from '../commands/agent.js';

const mockedExecFile = vi.mocked(execFile);

// ── Tests ────────────────────────────────────────────────────

describe('fetchDiffViaGh', () => {
  beforeEach(() => {
    mockedExecFile.mockClear();
  });

  it('returns diff content when gh succeeds', async () => {
    const diffContent =
      'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new';
    mockedExecFile.mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (
        err: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      process.nextTick(() => cb(null, diffContent, ''));
      return { pid: 0, kill: () => false };
    }) as typeof execFile);

    const result = await fetchDiffViaGh('test-org', 'test-repo', 42);

    expect(result).toBe(diffContent);
    expect(mockedExecFile).toHaveBeenCalledWith(
      'gh',
      ['api', 'repos/test-org/test-repo/pulls/42', '-H', 'Accept: application/vnd.github.v3.diff'],
      { maxBuffer: 50 * 1024 * 1024 },
      expect.any(Function),
    );
  });

  it('returns null when gh is not installed (ENOENT)', async () => {
    mockedExecFile.mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error) => void;
      const err = new Error('spawn gh ENOENT');
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      process.nextTick(() => cb(err));
      return { pid: 0, kill: () => false };
    }) as typeof execFile);

    const result = await fetchDiffViaGh('owner', 'repo', 1);

    expect(result).toBeNull();
  });

  it('returns null when gh command fails (not authenticated)', async () => {
    mockedExecFile.mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error) => void;
      process.nextTick(() => cb(new Error('gh: not logged in')));
      return { pid: 0, kill: () => false };
    }) as typeof execFile);

    const result = await fetchDiffViaGh('owner', 'repo', 1);

    expect(result).toBeNull();
  });

  it('returns null when gh returns HTTP error (e.g. 404)', async () => {
    mockedExecFile.mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error) => void;
      process.nextTick(() => cb(new Error('gh: Not Found (HTTP 404)')));
      return { pid: 0, kill: () => false };
    }) as typeof execFile);

    const result = await fetchDiffViaGh('owner', 'private-repo', 5);

    expect(result).toBeNull();
  });

  it('passes correct owner/repo/pr_number to gh api command', async () => {
    mockedExecFile.mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout?: string) => void;
      process.nextTick(() => cb(null, 'diff content', ''));
      return { pid: 0, kill: () => false };
    }) as typeof execFile);

    await fetchDiffViaGh('my-org', 'my-project', 123);

    expect(mockedExecFile).toHaveBeenCalledWith(
      'gh',
      ['api', 'repos/my-org/my-project/pulls/123', '-H', 'Accept: application/vnd.github.v3.diff'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('returns null and kills child process when signal is already aborted', async () => {
    const killFn = vi.fn(() => true);
    mockedExecFile.mockImplementation(((..._args: unknown[]) => {
      // Don't call callback — the abort handler should handle it
      return { pid: 123, kill: killFn };
    }) as typeof execFile);

    const controller = new AbortController();
    controller.abort();

    const result = await fetchDiffViaGh('owner', 'repo', 1, controller.signal);

    expect(result).toBeNull();
    expect(killFn).toHaveBeenCalled();
  });

  it('returns null and kills child process when signal fires during execution', async () => {
    const killFn = vi.fn(() => true);
    const controller = new AbortController();
    mockedExecFile.mockImplementation(((..._args: unknown[]) => {
      // Abort after the child is created but before it completes
      process.nextTick(() => controller.abort());
      return { pid: 123, kill: killFn };
    }) as typeof execFile);

    const result = await fetchDiffViaGh('owner', 'repo', 1, controller.signal);

    expect(result).toBeNull();
    expect(killFn).toHaveBeenCalled();
  });
});
