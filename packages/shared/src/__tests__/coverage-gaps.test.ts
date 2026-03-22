/**
 * Tests covering shared source gaps:
 * - api.ts: getModelDefaultReputation (lines 196-198)
 * - types.ts: isRepoAllowed default case (line 83)
 */
import { describe, it, expect } from 'vitest';
import { getModelDefaultReputation, DEFAULT_REPUTATION_FALLBACK } from '../api.js';
import { isRepoAllowed } from '../types.js';

describe('getModelDefaultReputation', () => {
  it('returns default reputation for known models', () => {
    expect(getModelDefaultReputation('claude-opus-4-6')).toBe(0.8);
    expect(getModelDefaultReputation('claude-sonnet-4-6')).toBe(0.7);
    expect(getModelDefaultReputation('qwen3.5-plus')).toBe(0.6);
  });

  it('returns DEFAULT_REPUTATION_FALLBACK for unknown models', () => {
    expect(getModelDefaultReputation('unknown-model')).toBe(DEFAULT_REPUTATION_FALLBACK);
    expect(getModelDefaultReputation('')).toBe(DEFAULT_REPUTATION_FALLBACK);
  });
});

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
