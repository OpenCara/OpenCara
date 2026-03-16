import { describe, it, expect } from 'vitest';
import { getVersion } from '@opencrust/shared';

describe('cli', () => {
  it('can import shared package', () => {
    expect(getVersion()).toBe('0.0.1');
  });
});
