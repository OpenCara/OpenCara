/**
 * Tests covering shared source gaps:
 * - types.ts: isRepoAllowed default case (line 83)
 */
import { describe, it, expect } from 'vitest';
import { isRepoAllowed } from '../types.js';

describe('isRepoAllowed edge cases', () => {
  it('returns true for null repoConfig', () => {
    expect(isRepoAllowed(null, 'owner', 'repo')).toBe(true);
  });

  it('returns true for undefined repoConfig', () => {
    expect(isRepoAllowed(undefined, 'owner', 'repo')).toBe(true);
  });

  it('returns true for mode=all', () => {
    expect(isRepoAllowed({ mode: 'all' }, 'any', 'repo')).toBe(true);
  });

  it('mode=own checks agentOwner against targetOwner', () => {
    expect(isRepoAllowed({ mode: 'own' }, 'owner', 'repo', 'owner')).toBe(true);
    expect(isRepoAllowed({ mode: 'own' }, 'owner', 'repo', 'other')).toBe(false);
    expect(isRepoAllowed({ mode: 'own' }, 'owner', 'repo')).toBe(false);
  });

  it('mode=whitelist checks list', () => {
    expect(isRepoAllowed({ mode: 'whitelist', list: ['owner/repo'] }, 'owner', 'repo')).toBe(true);
    expect(isRepoAllowed({ mode: 'whitelist', list: ['other/repo'] }, 'owner', 'repo')).toBe(false);
    // Empty list
    expect(isRepoAllowed({ mode: 'whitelist' }, 'owner', 'repo')).toBe(false);
  });

  it('mode=blacklist checks list', () => {
    expect(isRepoAllowed({ mode: 'blacklist', list: ['owner/repo'] }, 'owner', 'repo')).toBe(false);
    expect(isRepoAllowed({ mode: 'blacklist', list: ['other/repo'] }, 'owner', 'repo')).toBe(true);
  });

  it('unknown mode defaults to true', () => {
    expect(isRepoAllowed({ mode: 'unknown' as 'all' }, 'owner', 'repo')).toBe(true);
  });
});
