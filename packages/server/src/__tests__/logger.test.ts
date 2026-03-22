import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger, createLogger } from '../logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Logger', () => {
  it('info() outputs structured JSON to console.log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new Logger('req-123');
    logger.info('Test message', { taskId: 'abc' });

    expect(spy).toHaveBeenCalledOnce();
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.level).toBe('info');
    expect(entry.msg).toBe('Test message');
    expect(entry.requestId).toBe('req-123');
    expect(entry.taskId).toBe('abc');
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('warn() outputs structured JSON to console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = new Logger('req-456');
    logger.warn('Warning message');

    expect(spy).toHaveBeenCalledOnce();
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.level).toBe('warn');
    expect(entry.msg).toBe('Warning message');
    expect(entry.requestId).toBe('req-456');
  });

  it('error() outputs structured JSON to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new Logger('req-789');
    logger.error('Error occurred', { error: 'something broke' });

    expect(spy).toHaveBeenCalledOnce();
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.level).toBe('error');
    expect(entry.msg).toBe('Error occurred');
    expect(entry.requestId).toBe('req-789');
    expect(entry.error).toBe('something broke');
  });

  it('omits requestId when not provided', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new Logger();
    logger.info('No request context');

    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.requestId).toBeUndefined();
  });

  it('info() works with no additional data', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new Logger('req-abc');
    logger.info('Simple message');

    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.level).toBe('info');
    expect(entry.msg).toBe('Simple message');
  });
});

describe('createLogger', () => {
  it('creates a logger without requestId', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger();
    logger.info('From createLogger');

    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.level).toBe('info');
    expect(entry.msg).toBe('From createLogger');
    expect(entry.requestId).toBeUndefined();
  });
});
