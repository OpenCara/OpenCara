/**
 * Tests covering shared source gaps:
 * - types.ts: isRepoAllowed default case (line 83)
 */
import { describe, it, expect } from 'vitest';
import {
  isRepoAllowed,
  isDedupRole,
  isTriageRole,
  isImplementRole,
  isFixRole,
  isCodegenRole,
  isIssueReviewRole,
} from '../types.js';

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

  it('mode=private is case-insensitive for owner matching', () => {
    const orgs = new Set(['myorg']); // lowercased (as fetchUserOrgs returns)
    expect(isRepoAllowed({ mode: 'private' }, 'MyOrg', 'repo', 'alice', orgs)).toBe(true);
    expect(isRepoAllowed({ mode: 'private' }, 'MYORG', 'repo', 'alice', orgs)).toBe(true);
    // agentOwner case-insensitive
    expect(isRepoAllowed({ mode: 'private' }, 'Alice', 'repo', 'alice')).toBe(true);
    expect(isRepoAllowed({ mode: 'private' }, 'ALICE', 'repo', 'alice')).toBe(true);
  });

  it('mode=private with list: listed repos always allowed, unlisted fall back to org/owner', () => {
    const orgs = new Set(['my-org']);
    const config = { mode: 'private' as const, list: ['my-org/allowed-repo'] };
    expect(isRepoAllowed(config, 'my-org', 'allowed-repo', 'alice', orgs)).toBe(true);
    // Unlisted repo under org owner — falls back to org heuristic (allowed)
    expect(isRepoAllowed(config, 'my-org', 'other-repo', 'alice', orgs)).toBe(true);
    // Unlisted repo under unknown org — org heuristic rejects
    expect(isRepoAllowed(config, 'unknown-org', 'other-repo', 'alice', orgs)).toBe(false);
    // Explicitly-listed repo under non-org owner — allowed (collaborator access)
    expect(
      isRepoAllowed(
        { mode: 'private', list: ['unknown-org/repo'] },
        'unknown-org',
        'repo',
        'alice',
        orgs,
      ),
    ).toBe(true);
  });

  it('mode=private with list and own repos', () => {
    const config = { mode: 'private' as const, list: ['alice/my-repo'] };
    expect(isRepoAllowed(config, 'alice', 'my-repo', 'alice')).toBe(true);
    // Unlisted repo under own name — falls back to owner heuristic (allowed)
    expect(isRepoAllowed(config, 'alice', 'other-repo', 'alice')).toBe(true);
  });

  it('mode=private without list allows all own repos', () => {
    expect(isRepoAllowed({ mode: 'private' }, 'alice', 'any-repo', 'alice')).toBe(true);
  });

  it('mode=private with list allows collaborator repos (not org member)', () => {
    // User is not an org member but has collaborator access — explicitly-listed repos pass
    const config = { mode: 'private' as const, list: ['external-org/collab-repo'] };
    expect(isRepoAllowed(config, 'external-org', 'collab-repo', 'alice')).toBe(true);
    // Repo not in list is still rejected
    expect(isRepoAllowed(config, 'external-org', 'other-repo', 'alice')).toBe(false);
  });

  it('mode=private with list allows collaborator repos even with empty userOrgs', () => {
    const emptyOrgs = new Set<string>();
    const config = { mode: 'private' as const, list: ['external-org/collab-repo'] };
    expect(isRepoAllowed(config, 'external-org', 'collab-repo', 'alice', emptyOrgs)).toBe(true);
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

describe('role helper functions', () => {
  describe('isImplementRole', () => {
    it('returns true for implement', () => {
      expect(isImplementRole('implement')).toBe(true);
    });

    it('returns false for other roles', () => {
      expect(isImplementRole('review')).toBe(false);
      expect(isImplementRole('fix')).toBe(false);
      expect(isImplementRole('summary')).toBe(false);
    });
  });

  describe('isFixRole', () => {
    it('returns true for fix', () => {
      expect(isFixRole('fix')).toBe(true);
    });

    it('returns false for other roles', () => {
      expect(isFixRole('review')).toBe(false);
      expect(isFixRole('implement')).toBe(false);
      expect(isFixRole('summary')).toBe(false);
    });
  });

  describe('isCodegenRole', () => {
    it('returns true for implement', () => {
      expect(isCodegenRole('implement')).toBe(true);
    });

    it('returns true for fix', () => {
      expect(isCodegenRole('fix')).toBe(true);
    });

    it('returns false for non-codegen roles', () => {
      expect(isCodegenRole('review')).toBe(false);
      expect(isCodegenRole('summary')).toBe(false);
      expect(isCodegenRole('pr_dedup')).toBe(false);
      expect(isCodegenRole('issue_dedup')).toBe(false);
      expect(isCodegenRole('pr_triage')).toBe(false);
      expect(isCodegenRole('issue_triage')).toBe(false);
    });
  });

  describe('isDedupRole', () => {
    it('returns true for dedup roles', () => {
      expect(isDedupRole('pr_dedup')).toBe(true);
      expect(isDedupRole('issue_dedup')).toBe(true);
    });

    it('returns false for non-dedup roles', () => {
      expect(isDedupRole('review')).toBe(false);
      expect(isDedupRole('implement')).toBe(false);
      expect(isDedupRole('fix')).toBe(false);
    });
  });

  describe('isTriageRole', () => {
    it('returns true for triage roles', () => {
      expect(isTriageRole('pr_triage')).toBe(true);
      expect(isTriageRole('issue_triage')).toBe(true);
    });

    it('returns false for non-triage roles', () => {
      expect(isTriageRole('review')).toBe(false);
      expect(isTriageRole('implement')).toBe(false);
      expect(isTriageRole('fix')).toBe(false);
    });
  });

  describe('isIssueReviewRole', () => {
    it('returns true for issue_review', () => {
      expect(isIssueReviewRole('issue_review')).toBe(true);
    });

    it('returns false for other roles', () => {
      expect(isIssueReviewRole('review')).toBe(false);
      expect(isIssueReviewRole('implement')).toBe(false);
      expect(isIssueReviewRole('fix')).toBe(false);
      expect(isIssueReviewRole('summary')).toBe(false);
      expect(isIssueReviewRole('pr_triage')).toBe(false);
    });
  });
});
