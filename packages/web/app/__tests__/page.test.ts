import { describe, it, expect } from 'vitest';
import { getVersion } from '@opencrust/shared';

describe('web', () => {
  it('can import shared package', () => {
    expect(getVersion()).toBe('0.0.1');
  });
});
