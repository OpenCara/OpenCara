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

  it('returns true for mode=public', () => {
    expect(isRepoAllowed({ mode: 'public' }, 'any', 'repo')).toBe(true);
  });

  it('mode=private allows own repos', () => {
    expect(isRepoAllowed({ mode: 'private' }, 'owner', 'repo', 'owner')).toBe(true);
    expect(isRepoAllowed({ mode: 'private' }, 'owner', 'repo', 'other')).toBe(false);
    expect(isRepoAllowed({ mode: 'private' }, 'owner', 'repo')).toBe(false);
  });

  it('mode=private allows org repos via userOrgs', () => {
    const orgs = new Set(['my-org', 'other-org']);
    expect(isRepoAllowed({ mode: 'private' }, 'my-org', 'repo', 'alice', orgs)).toBe(true);
    expect(isRepoAllowed({ mode: 'private' }, 'other-org', 'repo', 'alice', orgs)).toBe(true);
    expect(isRepoAllowed({ mode: 'private' }, 'unknown-org', 'repo', 'alice', orgs)).toBe(false);
  });

  it('mode=private with list narrows within accessible repos', () => {
    const orgs = new Set(['my-org']);
    const config = { mode: 'private' as const, list: ['my-org/allowed-repo'] };
    expect(isRepoAllowed(config, 'my-org', 'allowed-repo', 'alice', orgs)).toBe(true);
    expect(isRepoAllowed(config, 'my-org', 'other-repo', 'alice', orgs)).toBe(false);
    // Not accessible org — rejected even if in list
    expect(
      isRepoAllowed(
        { mode: 'private', list: ['unknown-org/repo'] },
        'unknown-org',
        'repo',
        'alice',
        orgs,
      ),
    ).toBe(false);
  });

  it('mode=private with list and own repos', () => {
    const config = { mode: 'private' as const, list: ['alice/my-repo'] };
    expect(isRepoAllowed(config, 'alice', 'my-repo', 'alice')).toBe(true);
    expect(isRepoAllowed(config, 'alice', 'other-repo', 'alice')).toBe(false);
  });

  it('mode=private without list allows all own repos', () => {
    expect(isRepoAllowed({ mode: 'private' }, 'alice', 'any-repo', 'alice')).toBe(true);
  });

  it('mode=private with empty list allows all accessible repos', () => {
    const orgs = new Set(['my-org']);
    expect(isRepoAllowed({ mode: 'private', list: [] }, 'my-org', 'repo', 'alice', orgs)).toBe(
      true,
    );
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
    expect(isRepoAllowed({ mode: 'unknown' as 'public' }, 'owner', 'repo')).toBe(true);
  });
});
