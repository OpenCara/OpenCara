import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createLogger,
  createAgentSession,
  formatUptime,
  formatExitSummary,
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
});
