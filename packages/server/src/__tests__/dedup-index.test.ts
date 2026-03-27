/**
 * Tests for the structured 3-comment dedup index layout (issue #525).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  OPEN_MARKER,
  RECENT_MARKER,
  ARCHIVED_MARKER,
  findIndexComments,
  ensureIndexComments,
  appendOpenEntry,
  buildIndexBody,
  fetchIndexBody,
} from '../dedup-index.js';
import { NoOpGitHubService } from '../github/service.js';
import { createLogger } from '../logger.js';

describe('Dedup Index (Issue #525)', () => {
  let github: NoOpGitHubService;
  let logger: ReturnType<typeof createLogger>;
  const owner = 'test-org';
  const repo = 'test-repo';
  const issueNumber = 10;
  const token = 'test-token';

  beforeEach(() => {
    github = new NoOpGitHubService();
    logger = createLogger();
  });

  describe('findIndexComments', () => {
    it('returns null for all when no comments match', () => {
      const result = findIndexComments([
        { id: 1, body: 'Some random comment' },
        { id: 2, body: 'Another comment' },
      ]);
      expect(result.open).toBeNull();
      expect(result.recent).toBeNull();
      expect(result.archived).toBeNull();
    });

    it('finds all 3 structured comments by markers', () => {
      const comments = [
        { id: 1, body: `${OPEN_MARKER}\n## Open Items\n- #1 [bug] — Fix crash` },
        { id: 2, body: `${RECENT_MARKER}\n## Recently Closed Items\n- #2 [feat]` },
        { id: 3, body: `${ARCHIVED_MARKER}\n## Archived Items\n- #3 [bug]` },
      ];
      const result = findIndexComments(comments);
      expect(result.open).toEqual(comments[0]);
      expect(result.recent).toEqual(comments[1]);
      expect(result.archived).toEqual(comments[2]);
    });

    it('finds partial matches (only open exists)', () => {
      const comments = [
        { id: 5, body: 'Unrelated' },
        { id: 10, body: `${OPEN_MARKER}\n## Open Items\n` },
      ];
      const result = findIndexComments(comments);
      expect(result.open).toEqual(comments[1]);
      expect(result.recent).toBeNull();
      expect(result.archived).toBeNull();
    });

    it('handles empty comments list', () => {
      const result = findIndexComments([]);
      expect(result.open).toBeNull();
      expect(result.recent).toBeNull();
      expect(result.archived).toBeNull();
    });
  });

  describe('ensureIndexComments', () => {
    it('creates all 3 comments when none exist', async () => {
      const createSpy = vi.spyOn(github, 'createIssueComment');
      const result = await ensureIndexComments(github, owner, repo, issueNumber, token, logger);

      expect(createSpy).toHaveBeenCalledTimes(3);
      expect(result.openId).toBeDefined();
      expect(result.recentId).toBeDefined();
      expect(result.archivedId).toBeDefined();
      // All IDs should be different
      expect(new Set([result.openId, result.recentId, result.archivedId]).size).toBe(3);
    });

    it('does not create comments that already exist', async () => {
      // Pre-create the open comment
      await github.createIssueComment(
        owner,
        repo,
        issueNumber,
        `${OPEN_MARKER}\n## Open Items\n`,
        token,
      );

      const createSpy = vi.spyOn(github, 'createIssueComment');
      const result = await ensureIndexComments(github, owner, repo, issueNumber, token, logger);

      // Should only create 2 (recent + archived), not the open one
      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(result.openId).toBeDefined();
      expect(result.recentId).toBeDefined();
      expect(result.archivedId).toBeDefined();
    });

    it('does not create any when all 3 exist', async () => {
      await github.createIssueComment(
        owner,
        repo,
        issueNumber,
        `${OPEN_MARKER}\n## Open Items\n`,
        token,
      );
      await github.createIssueComment(
        owner,
        repo,
        issueNumber,
        `${RECENT_MARKER}\n## Recently Closed Items\n`,
        token,
      );
      await github.createIssueComment(
        owner,
        repo,
        issueNumber,
        `${ARCHIVED_MARKER}\n## Archived Items\n`,
        token,
      );

      const createSpy = vi.spyOn(github, 'createIssueComment');
      await ensureIndexComments(github, owner, repo, issueNumber, token, logger);
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  describe('appendOpenEntry', () => {
    it('creates comments and appends entry when no comments exist', async () => {
      await appendOpenEntry(github, owner, repo, issueNumber, '- #42 [bug] — Fix', token, logger);

      const comments = await github.listIssueComments(owner, repo, issueNumber, token);
      expect(comments).toHaveLength(3);

      const openComment = comments.find((c) => c.body.includes(OPEN_MARKER));
      expect(openComment).toBeDefined();
      expect(openComment!.body).toContain('- #42 [bug] — Fix');
    });

    it('appends to existing open comment', async () => {
      // Create initial comment
      await appendOpenEntry(github, owner, repo, issueNumber, '- #1 [feat] — Add', token, logger);

      // Append another entry
      await appendOpenEntry(github, owner, repo, issueNumber, '- #2 [bug] — Fix', token, logger);

      const comments = await github.listIssueComments(owner, repo, issueNumber, token);
      const openComment = comments.find((c) => c.body.includes(OPEN_MARKER));
      expect(openComment!.body).toContain('- #1 [feat] — Add');
      expect(openComment!.body).toContain('- #2 [bug] — Fix');
    });
  });

  describe('buildIndexBody', () => {
    it('returns empty string when all comments are null', () => {
      const result = buildIndexBody({ open: null, recent: null, archived: null });
      expect(result).toBe('');
    });

    it('combines all comment bodies, stripping markers', () => {
      const index = {
        open: {
          id: 1,
          body: `${OPEN_MARKER}\n## Open Items\n- #1 [bug] — Crash fix`,
        },
        recent: {
          id: 2,
          body: `${RECENT_MARKER}\n## Recently Closed Items\n- #2 [feat] — New API`,
        },
        archived: {
          id: 3,
          body: `${ARCHIVED_MARKER}\n## Archived Items\n- #3 [bug]`,
        },
      };

      const result = buildIndexBody(index);
      expect(result).toContain('## Open Items');
      expect(result).toContain('- #1 [bug] — Crash fix');
      expect(result).toContain('## Recently Closed Items');
      expect(result).toContain('- #2 [feat] — New API');
      expect(result).toContain('## Archived Items');
      expect(result).toContain('- #3 [bug]');
      // Markers should be stripped
      expect(result).not.toContain(OPEN_MARKER);
      expect(result).not.toContain(RECENT_MARKER);
      expect(result).not.toContain(ARCHIVED_MARKER);
    });

    it('works with only one comment present', () => {
      const index = {
        open: { id: 1, body: `${OPEN_MARKER}\n## Open Items\n- #5 [feat] — Feature` },
        recent: null,
        archived: null,
      };
      const result = buildIndexBody(index);
      expect(result).toContain('- #5 [feat] — Feature');
      expect(result).not.toContain(OPEN_MARKER);
    });
  });

  describe('fetchIndexBody', () => {
    it('returns empty string when no structured comments exist', async () => {
      const result = await fetchIndexBody(github, owner, repo, issueNumber, token);
      expect(result).toBe('');
    });

    it('returns combined body from structured comments', async () => {
      // Create structured comments
      await github.createIssueComment(
        owner,
        repo,
        issueNumber,
        `${OPEN_MARKER}\n## Open Items\n- #10 [bug] — Fix OOM`,
        token,
      );
      await github.createIssueComment(
        owner,
        repo,
        issueNumber,
        `${RECENT_MARKER}\n## Recently Closed Items\n- #8 [feat] — API v2`,
        token,
      );
      await github.createIssueComment(
        owner,
        repo,
        issueNumber,
        `${ARCHIVED_MARKER}\n## Archived Items\n- #3 [bug]`,
        token,
      );

      const result = await fetchIndexBody(github, owner, repo, issueNumber, token);
      expect(result).toContain('- #10 [bug] — Fix OOM');
      expect(result).toContain('- #8 [feat] — API v2');
      expect(result).toContain('- #3 [bug]');
    });
  });
});
