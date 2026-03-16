import { describe, it, expect } from 'vitest';
import {
  calculateDelay,
  DEFAULT_RECONNECT_OPTIONS,
  type ReconnectOptions,
} from '../reconnect.js';

describe('reconnect', () => {
  const noJitter: ReconnectOptions = {
    initialDelay: 1000,
    maxDelay: 30000,
    multiplier: 2,
    jitter: false,
  };

  it('first attempt returns initialDelay', () => {
    expect(calculateDelay(0, noJitter)).toBe(1000);
  });

  it('grows exponentially', () => {
    expect(calculateDelay(1, noJitter)).toBe(2000);
    expect(calculateDelay(2, noJitter)).toBe(4000);
    expect(calculateDelay(3, noJitter)).toBe(8000);
  });

  it('caps at maxDelay', () => {
    expect(calculateDelay(10, noJitter)).toBe(30000);
    expect(calculateDelay(20, noJitter)).toBe(30000);
  });

  it('adds jitter when enabled', () => {
    const withJitter: ReconnectOptions = { ...noJitter, jitter: true };
    const delay = calculateDelay(0, withJitter);
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThan(1500);
  });

  it('default options match expected values', () => {
    expect(DEFAULT_RECONNECT_OPTIONS.initialDelay).toBe(1000);
    expect(DEFAULT_RECONNECT_OPTIONS.maxDelay).toBe(30000);
    expect(DEFAULT_RECONNECT_OPTIONS.multiplier).toBe(2);
    expect(DEFAULT_RECONNECT_OPTIONS.jitter).toBe(true);
  });
});
