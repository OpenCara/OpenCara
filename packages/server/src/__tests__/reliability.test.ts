import { describe, it, expect } from 'vitest';
import { computeReliability, type ReliabilityEvent } from '../reliability.js';

function event(outcome: 'success' | 'error'): ReliabilityEvent {
  return { outcome, created_at: new Date().toISOString() };
}

describe('computeReliability', () => {
  it('returns 1.0 for an empty history (no cold-start penalty)', () => {
    expect(computeReliability([])).toBe(1.0);
  });

  it('returns 1.0 when all events succeeded', () => {
    expect(computeReliability([event('success'), event('success'), event('success')])).toBe(1.0);
  });

  it('returns 0 when every event failed (no floor)', () => {
    expect(computeReliability([event('error'), event('error'), event('error')])).toBe(0);
  });

  it('returns the success ratio for mixed outcomes', () => {
    expect(
      computeReliability([event('success'), event('success'), event('error'), event('error')]),
    ).toBe(0.5);
  });

  it('handles a single event', () => {
    expect(computeReliability([event('success')])).toBe(1.0);
    expect(computeReliability([event('error')])).toBe(0);
  });
});
