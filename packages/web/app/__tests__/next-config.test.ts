import { describe, it, expect } from 'vitest';

describe('next.config', () => {
  it('exports a valid configuration object', async () => {
    const mod = await import('../../next.config.js');
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe('object');
  });

  it('sets outputFileTracingRoot', async () => {
    const mod = await import('../../next.config.js');
    expect(typeof mod.default.outputFileTracingRoot).toBe('string');
    expect(mod.default.outputFileTracingRoot).toBeTruthy();
  });
});
