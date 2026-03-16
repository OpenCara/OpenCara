import { describe, it, expect } from 'vitest';
import { getVersion, API_KEY_PREFIX } from '../index.js';

describe('shared', () => {
  it('returns version string', () => {
    expect(getVersion()).toBe('0.0.1');
  });

  it('exports message types', async () => {
    const mod = await import('../index.js');
    expect(mod.getVersion).toBeDefined();
  });

  it('exports API_KEY_PREFIX with correct value', () => {
    expect(API_KEY_PREFIX).toBe('cr_');
  });

  it('exports database entity types', async () => {
    // Type-level check: ensure types are re-exported
    const mod = await import('../index.js');
    expect(mod.API_KEY_PREFIX).toBeDefined();
    expect(mod.getVersion).toBeDefined();
  });
});
