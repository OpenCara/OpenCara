import { describe, it, expect } from 'vitest';
import { getVersion } from '../index.js';

describe('shared', () => {
  it('returns version string', () => {
    expect(getVersion()).toBe('0.0.1');
  });

  it('exports message types', async () => {
    const mod = await import('../index.js');
    expect(mod.getVersion).toBeDefined();
  });
});
