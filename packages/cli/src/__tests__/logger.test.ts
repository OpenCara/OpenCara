import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createLogger,
  createAgentSession,
  formatUptime,
  formatExitSummary,
  formatVersionBanner,
  formatAgentTools,
  logVerboseToolOutput,
  VERBOSE_TRUNCATE_LIMIT,
  timestamp,
  icons,
} from '../logger.js';

describe('logger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('timestamp', () => {
    it('returns HH:MM:SS format', () => {
      const ts = timestamp();
      expect(ts).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });
  });

  describe('createLogger', () => {
    it('log prepends timestamp', () => {
      const logger = createLogger();
      logger.log('hello');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('hello'));
      // Should contain a timestamp pattern
      const call = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(call).toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    it('logError prepends timestamp and uses console.error', () => {
      const logger = createLogger();
      logger.logError('bad thing');
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('bad thing'));
      const call = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(call).toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    it('logWarn prepends timestamp and uses console.warn', () => {
      const logger = createLogger();
      logger.logWarn('caution');
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('caution'));
      const call = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(call).toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    it('includes label when provided', () => {
      const logger = createLogger('my-agent');
      logger.log('test');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('my-agent'));
    });

    it('does not include label when not provided', () => {
      const logger = createLogger();
      logger.log('test');
      const call = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      // Strip ANSI escape codes before matching (picocolors adds brackets like [2m, [22m)
      // eslint-disable-next-line no-control-regex
      const stripped = call.replace(/\x1b\[[0-9;]*m/g, '');
      // Should not have a label bracket other than the timestamp
      expect(stripped).not.toMatch(/\[(?!\d{2}:\d{2}:\d{2}\])[^\]]+\]/);
    });

    it('sanitizes tokens from messages', () => {
      const logger = createLogger();
      logger.log('token gho_abc123xyz is here');
      const call = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(call).not.toContain('gho_abc123xyz');
    });
  });

  describe('icons', () => {
    it('has all required status indicators', () => {
      expect(icons.start).toBeDefined();
      expect(icons.polling).toBeDefined();
      expect(icons.success).toBeDefined();
      expect(icons.running).toBeDefined();
      expect(icons.stop).toBeDefined();
      expect(icons.warn).toBeDefined();
      expect(icons.error).toBeDefined();
    });
  });

  describe('formatUptime', () => {
    it('formats seconds only', () => {
      expect(formatUptime(45_000)).toBe('45s');
    });

    it('formats minutes and seconds', () => {
      expect(formatUptime(75_000)).toBe('1m15s');
    });

    it('formats hours, minutes, and seconds', () => {
      expect(formatUptime(3_661_000)).toBe('1h1m1s');
    });

    it('handles zero', () => {
      expect(formatUptime(0)).toBe('0s');
    });

    it('handles exact minute boundary', () => {
      expect(formatUptime(60_000)).toBe('1m0s');
    });

    it('handles exact hour boundary', () => {
      expect(formatUptime(3_600_000)).toBe('1h0m0s');
    });
  });

  describe('createAgentSession', () => {
    it('initializes with zero counters and current time', () => {
      const before = Date.now();
      const session = createAgentSession();
      const after = Date.now();

      expect(session.tasksCompleted).toBe(0);
      expect(session.errorsEncountered).toBe(0);
      expect(session.startTime).toBeGreaterThanOrEqual(before);
      expect(session.startTime).toBeLessThanOrEqual(after);
    });
  });

  describe('formatExitSummary', () => {
    it('formats summary with singular task and error', () => {
      const session = createAgentSession();
      session.tasksCompleted = 1;
      session.errorsEncountered = 1;
      const summary = formatExitSummary(session);
      expect(summary).toContain('1 task completed');
      expect(summary).toContain('1 error');
      expect(summary).toContain('Shutting down');
    });

    it('formats summary with plural tasks and errors', () => {
      const session = createAgentSession();
      session.tasksCompleted = 5;
      session.errorsEncountered = 2;
      const summary = formatExitSummary(session);
      expect(summary).toContain('5 tasks completed');
      expect(summary).toContain('2 errors');
    });

    it('formats summary with zero tasks', () => {
      const session = createAgentSession();
      const summary = formatExitSummary(session);
      expect(summary).toContain('0 tasks completed');
      expect(summary).toContain('0 errors');
    });

    it('includes uptime', () => {
      const session = createAgentSession();
      // Simulate 90 seconds of uptime
      session.startTime = Date.now() - 90_000;
      const summary = formatExitSummary(session);
      expect(summary).toContain('1m30s');
    });
  });

  describe('formatVersionBanner', () => {
    it('formats version and commit hash', () => {
      expect(formatVersionBanner('0.19.6', 'abc1234')).toBe('OpenCara CLI v0.19.6 (abc1234)');
    });

    it('handles unknown commit hash', () => {
      expect(formatVersionBanner('1.0.0', 'unknown')).toBe('OpenCara CLI v1.0.0 (unknown)');
    });
  });

  describe('formatAgentTools', () => {
    it('formats single agent with roles', () => {
      const lines = formatAgentTools([
        { tool: 'claude', roles: ['review', 'summary', 'implement', 'fix'] },
      ]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('claude');
      expect(lines[0]).toContain('review, summary, implement, fix');
    });

    it('formats multiple agents with aligned labels', () => {
      const lines = formatAgentTools([
        { tool: 'claude', roles: ['review', 'summary'] },
        { tool: 'codex', roles: ['review', 'implement'] },
        { tool: 'gemini', roles: ['review'] },
      ]);
      expect(lines).toHaveLength(3);
      // All lines should have the same prefix length (aligned by tool name padding)
      const dashPositions = lines.map((l) => l.indexOf('—'));
      expect(new Set(dashPositions).size).toBe(1);
    });

    it('uses agent name when provided', () => {
      const lines = formatAgentTools([{ tool: 'claude', name: 'my-reviewer', roles: ['review'] }]);
      expect(lines[0]).toContain('my-reviewer');
    });

    it('falls back to tool name when no agent name', () => {
      const lines = formatAgentTools([{ tool: 'claude', roles: ['review'] }]);
      expect(lines[0]).toContain('claude');
    });

    it('returns empty array for no agents', () => {
      expect(formatAgentTools([])).toEqual([]);
    });

    it('produces trailing em-dash with empty roles (callers guarantee non-empty via computeRoles)', () => {
      const lines = formatAgentTools([{ tool: 'claude', roles: [] }]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('claude');
      expect(lines[0]).toMatch(/— $/);
    });

    it('handles agents with different label lengths', () => {
      const lines = formatAgentTools([
        { tool: 'a', roles: ['review'] },
        { tool: 'long-tool-name', roles: ['summary'] },
      ]);
      expect(lines).toHaveLength(2);
      // Longer name should not be padded
      expect(lines[1]).toMatch(/long-tool-name\s{2}—/);
      // Shorter name should be padded
      expect(lines[0]).toMatch(/a\s+—/);
    });
  });

  describe('logVerboseToolOutput', () => {
    it('logs prompt length with estimated tokens', () => {
      const logger = createLogger();
      logVerboseToolOutput(logger, 'Review', 'some output', '', 400);
      const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      const promptLine = calls.find((c) => c.includes('[verbose]') && c.includes('prompt:'));
      expect(promptLine).toBeDefined();
      expect(promptLine).toContain('400 chars');
      expect(promptLine).toContain('~100 tokens');
    });

    it('logs stdout content with char count', () => {
      const logger = createLogger();
      logVerboseToolOutput(logger, 'Review', 'tool output here', '', 100);
      const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      const stdoutLine = calls.find((c) => c.includes('stdout') && c.includes('16 chars'));
      expect(stdoutLine).toBeDefined();
      expect(stdoutLine).toContain('tool output here');
    });

    it('logs empty stdout marker when stdout is empty', () => {
      const logger = createLogger();
      logVerboseToolOutput(logger, 'Review', '', '', 100);
      const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      expect(calls.some((c) => c.includes('stdout: (empty)'))).toBe(true);
    });

    it('logs stderr when present', () => {
      const logger = createLogger();
      logVerboseToolOutput(logger, 'Review', 'out', 'error output', 100);
      const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      const stderrLine = calls.find((c) => c.includes('stderr'));
      expect(stderrLine).toBeDefined();
      expect(stderrLine).toContain('error output');
    });

    it('does not log stderr when empty', () => {
      const logger = createLogger();
      logVerboseToolOutput(logger, 'Review', 'out', '', 100);
      const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      expect(calls.some((c) => c.includes('stderr'))).toBe(false);
    });

    it('truncates stdout exceeding the limit', () => {
      const logger = createLogger();
      const longOutput = 'x'.repeat(VERBOSE_TRUNCATE_LIMIT + 500);
      logVerboseToolOutput(logger, 'Review', longOutput, '', 100);
      const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      const stdoutLine = calls.find((c) => c.includes('stdout'));
      expect(stdoutLine).toBeDefined();
      expect(stdoutLine).toContain('truncated');
      // The logged content should not contain the full string
      expect(stdoutLine!.length).toBeLessThan(longOutput.length);
    });

    it('truncates stderr exceeding the limit', () => {
      const logger = createLogger();
      const longErr = 'e'.repeat(VERBOSE_TRUNCATE_LIMIT + 200);
      logVerboseToolOutput(logger, 'Review', 'out', longErr, 100);
      const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      const stderrLine = calls.find((c) => c.includes('stderr'));
      expect(stderrLine).toBeDefined();
      expect(stderrLine).toContain('truncated');
    });

    it('uses custom truncation limit', () => {
      const logger = createLogger();
      const output = 'a'.repeat(150);
      logVerboseToolOutput(logger, 'Review', output, '', 100, 100);
      const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      const stdoutLine = calls.find((c) => c.includes('stdout'));
      expect(stdoutLine).toContain('truncated');
    });

    it('includes label in all log lines', () => {
      const logger = createLogger();
      logVerboseToolOutput(logger, 'Summary', 'out', 'err', 100);
      const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      const verboseCalls = calls.filter((c) => c.includes('[verbose]'));
      expect(verboseCalls.length).toBeGreaterThanOrEqual(2);
      for (const call of verboseCalls) {
        expect(call).toContain('Summary');
      }
    });
  });
});
