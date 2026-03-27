/**
 * Tests for the structured 3-comment dedup index layout (issue #525)
 * and lifecycle management (issue #534).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  OPEN_MARKER,
  RECENT_MARKER,
  ARCHIVED_MARKER,
  DEFAULT_AGE_OUT_MS,
  findIndexComments,
  ensureIndexComments,
  appendOpenEntry,
  buildIndexBody,
  fetchIndexBody,
  parseEntryNumber,
  extractEntries,
  removeEntry,
  formatCloseDate,
  parseCloseDate,
  toArchivedEntry,
  moveToRecentlyClosed,
  ageOutToArchived,
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

  // ── Lifecycle tests (Issue #534) ──────────────────────────────

  describe('parseEntryNumber', () => {
    it('extracts number from standard entry', () => {
      expect(parseEntryNumber('- #42 [bug] — Fix crash')).toBe(42);
    });

    it('extracts number from entry with colon format', () => {
      expect(parseEntryNumber('- #5: duplicate of #3')).toBe(5);
    });

    it('returns null for non-entry lines', () => {
      expect(parseEntryNumber('## Open Items')).toBeNull();
      expect(parseEntryNumber('')).toBeNull();
      expect(parseEntryNumber('Some text')).toBeNull();
    });
  });

  describe('extractEntries', () => {
    it('extracts entry lines from comment body', () => {
      const body = `${OPEN_MARKER}\n## Open Items\n- #1 [bug] — Fix\n- #2 [feat] — Add`;
      const entries = extractEntries(body);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toContain('#1');
      expect(entries[1]).toContain('#2');
    });

    it('returns empty array for header-only body', () => {
      expect(extractEntries(`${OPEN_MARKER}\n## Open Items\n`)).toHaveLength(0);
    });
  });

  describe('removeEntry', () => {
    it('removes matching entry and returns it', () => {
      const body = `${OPEN_MARKER}\n## Open Items\n- #1 [bug] — Fix\n- #2 [feat] — Add`;
      const result = removeEntry(body, 1);
      expect(result.entry).toBe('- #1 [bug] — Fix');
      expect(result.body).not.toContain('- #1');
      expect(result.body).toContain('- #2 [feat] — Add');
    });

    it('returns null entry when not found', () => {
      const body = `${OPEN_MARKER}\n## Open Items\n- #1 [bug] — Fix`;
      const result = removeEntry(body, 99);
      expect(result.entry).toBeNull();
      expect(result.body).toContain('- #1 [bug] — Fix');
    });
  });

  describe('formatCloseDate / parseCloseDate', () => {
    it('formats date as ISO YYYY-MM-DD', () => {
      const ts = new Date('2026-03-27T12:00:00Z').getTime();
      expect(formatCloseDate(ts)).toBe('2026-03-27');
    });

    it('parses close date from entry line', () => {
      const line = '- #42 [bug] — Fix crash (closed 2026-03-27)';
      const parsed = parseCloseDate(line);
      expect(parsed).toBe(new Date('2026-03-27').getTime());
    });

    it('returns null when no close date present', () => {
      expect(parseCloseDate('- #42 [bug] — Fix crash')).toBeNull();
    });
  });

  describe('toArchivedEntry', () => {
    it('compacts entry to number + title only', () => {
      expect(toArchivedEntry('- #42 [bug] [critical] — Fix crash (closed 2026-03-01)')).toBe(
        '- #42 — Fix crash',
      );
    });

    it('handles entry without labels', () => {
      expect(toArchivedEntry('- #10 — Add feature (closed 2026-01-15)')).toBe(
        '- #10 — Add feature',
      );
    });

    it('strips close date even without labels', () => {
      expect(toArchivedEntry('- #5 — Simple (closed 2026-02-01)')).toBe('- #5 — Simple');
    });
  });

  describe('moveToRecentlyClosed', () => {
    const now = new Date('2026-03-27T12:00:00Z').getTime();

    it('moves entry from Open to Recently Closed with date', async () => {
      // Set up: add an entry to Open
      await appendOpenEntry(
        github,
        owner,
        repo,
        issueNumber,
        '- #42 [bug] — Fix crash',
        token,
        logger,
      );

      await moveToRecentlyClosed(github, owner, repo, issueNumber, 42, token, logger, now);

      const comments = await github.listIssueComments(owner, repo, issueNumber, token);
      const openComment = comments.find((c) => c.body.includes(OPEN_MARKER))!;
      const recentComment = comments.find((c) => c.body.includes(RECENT_MARKER))!;

      // Entry removed from Open
      expect(openComment.body).not.toContain('- #42');
      // Entry added to Recently Closed with date
      expect(recentComment.body).toContain('- #42 [bug] — Fix crash (closed 2026-03-27)');
    });

    it('is a no-op when entry not found in Open', async () => {
      // Set up: ensure comments exist but no matching entry
      await appendOpenEntry(
        github,
        owner,
        repo,
        issueNumber,
        '- #1 [feat] — Add feature',
        token,
        logger,
      );

      const updateSpy = vi.spyOn(github, 'updateIssueComment');
      await moveToRecentlyClosed(github, owner, repo, issueNumber, 99, token, logger, now);

      // Only 1 update from appendOpenEntry; moveToRecentlyClosed should not update
      // (it calls ensureIndexComments which doesn't update, then returns early)
      // The spy tracks all calls, including those from appendOpenEntry
      const callsBeforeMove = updateSpy.mock.calls.length;
      await moveToRecentlyClosed(github, owner, repo, issueNumber, 99, token, logger, now);
      expect(updateSpy.mock.calls.length).toBe(callsBeforeMove); // no new updates
    });

    it('preserves other entries in Open when moving one', async () => {
      await appendOpenEntry(
        github,
        owner,
        repo,
        issueNumber,
        '- #1 [feat] — Feature A',
        token,
        logger,
      );
      await appendOpenEntry(github, owner, repo, issueNumber, '- #2 [bug] — Bug B', token, logger);
      await appendOpenEntry(
        github,
        owner,
        repo,
        issueNumber,
        '- #3 [feat] — Feature C',
        token,
        logger,
      );

      await moveToRecentlyClosed(github, owner, repo, issueNumber, 2, token, logger, now);

      const comments = await github.listIssueComments(owner, repo, issueNumber, token);
      const openComment = comments.find((c) => c.body.includes(OPEN_MARKER))!;
      const recentComment = comments.find((c) => c.body.includes(RECENT_MARKER))!;

      expect(openComment.body).toContain('- #1 [feat] — Feature A');
      expect(openComment.body).not.toContain('- #2');
      expect(openComment.body).toContain('- #3 [feat] — Feature C');
      expect(recentComment.body).toContain('- #2 [bug] — Bug B (closed 2026-03-27)');
    });
  });

  describe('ageOutToArchived', () => {
    const day = 24 * 60 * 60 * 1000;
    const now = new Date('2026-04-15T12:00:00Z').getTime();

    it('moves old entries from Recently Closed to Archived', async () => {
      // Set up: manually create comments with entries
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
        `${RECENT_MARKER}\n## Recently Closed Items\n\n- #10 [bug] — Old bug (closed 2026-03-01)\n- #20 [feat] — Recent feat (closed 2026-04-10)`,
        token,
      );
      await github.createIssueComment(
        owner,
        repo,
        issueNumber,
        `${ARCHIVED_MARKER}\n## Archived Items\n`,
        token,
      );

      await ageOutToArchived(github, owner, repo, issueNumber, token, logger, now);

      const comments = await github.listIssueComments(owner, repo, issueNumber, token);
      const recentComment = comments.find((c) => c.body.includes(RECENT_MARKER))!;
      const archivedComment = comments.find((c) => c.body.includes(ARCHIVED_MARKER))!;

      // #10 is older than 30 days (2026-03-01 to 2026-04-15 = 45 days) — should be archived
      expect(recentComment.body).not.toContain('#10');
      expect(recentComment.body).toContain('#20'); // only 5 days old — stays

      // #10 should appear in archived in compact format
      expect(archivedComment.body).toContain('- #10 — Old bug');
      expect(archivedComment.body).not.toContain('[bug]'); // labels stripped in compact format
    });

    it('is a no-op when no entries are old enough', async () => {
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
        `${RECENT_MARKER}\n## Recently Closed Items\n\n- #20 [feat] — Recent (closed 2026-04-10)`,
        token,
      );
      await github.createIssueComment(
        owner,
        repo,
        issueNumber,
        `${ARCHIVED_MARKER}\n## Archived Items\n`,
        token,
      );

      const updateSpy = vi.spyOn(github, 'updateIssueComment');
      await ageOutToArchived(github, owner, repo, issueNumber, token, logger, now);

      // No updates needed — nothing to archive
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('archives all entries when all are old', async () => {
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
        `${RECENT_MARKER}\n## Recently Closed Items\n\n- #1 [bug] — Bug A (closed 2026-01-01)\n- #2 [feat] — Feat B (closed 2026-02-01)`,
        token,
      );
      await github.createIssueComment(
        owner,
        repo,
        issueNumber,
        `${ARCHIVED_MARKER}\n## Archived Items\n`,
        token,
      );

      await ageOutToArchived(github, owner, repo, issueNumber, token, logger, now);

      const comments = await github.listIssueComments(owner, repo, issueNumber, token);
      const recentComment = comments.find((c) => c.body.includes(RECENT_MARKER))!;
      const archivedComment = comments.find((c) => c.body.includes(ARCHIVED_MARKER))!;

      // Both should be moved to archived
      expect(recentComment.body).not.toContain('#1');
      expect(recentComment.body).not.toContain('#2');
      expect(archivedComment.body).toContain('- #1 — Bug A');
      expect(archivedComment.body).toContain('- #2 — Feat B');
    });

    it('uses custom ageOutMs parameter', async () => {
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
        `${RECENT_MARKER}\n## Recently Closed Items\n\n- #5 [bug] — Five days ago (closed 2026-04-10)`,
        token,
      );
      await github.createIssueComment(
        owner,
        repo,
        issueNumber,
        `${ARCHIVED_MARKER}\n## Archived Items\n`,
        token,
      );

      // With a 3-day window, the 5-day-old entry should be archived
      await ageOutToArchived(github, owner, repo, issueNumber, token, logger, now, 3 * day);

      const comments = await github.listIssueComments(owner, repo, issueNumber, token);
      const archivedComment = comments.find((c) => c.body.includes(ARCHIVED_MARKER))!;
      expect(archivedComment.body).toContain('- #5 — Five days ago');
    });
  });

  describe('DEFAULT_AGE_OUT_MS', () => {
    it('equals 30 days in milliseconds', () => {
      expect(DEFAULT_AGE_OUT_MS).toBe(30 * 24 * 60 * 60 * 1000);
    });
  });

  describe('ensureIndexComments returns bodies', () => {
    it('returns recentBody and archivedBody', async () => {
      await github.createIssueComment(
        owner,
        repo,
        issueNumber,
        `${OPEN_MARKER}\n## Open Items\n- #1 — Test`,
        token,
      );
      await github.createIssueComment(
        owner,
        repo,
        issueNumber,
        `${RECENT_MARKER}\n## Recently Closed Items\n- #2 — Closed`,
        token,
      );
      await github.createIssueComment(
        owner,
        repo,
        issueNumber,
        `${ARCHIVED_MARKER}\n## Archived Items\n- #3 — Old`,
        token,
      );

      const result = await ensureIndexComments(github, owner, repo, issueNumber, token, logger);
      expect(result.recentBody).toContain('- #2 — Closed');
      expect(result.archivedBody).toContain('- #3 — Old');
    });
  });

  describe('full lifecycle integration', () => {
    const now = new Date('2026-03-27T12:00:00Z').getTime();
    const day = 24 * 60 * 60 * 1000;

    it('open → close → age-out full cycle', async () => {
      // Step 1: Add entries to Open
      await appendOpenEntry(
        github,
        owner,
        repo,
        issueNumber,
        '- #10 [bug] — Fix crash',
        token,
        logger,
      );
      await appendOpenEntry(
        github,
        owner,
        repo,
        issueNumber,
        '- #20 [feat] — New API',
        token,
        logger,
      );

      // Step 2: Close #10
      await moveToRecentlyClosed(github, owner, repo, issueNumber, 10, token, logger, now);

      let comments = await github.listIssueComments(owner, repo, issueNumber, token);
      const openComment = comments.find((c) => c.body.includes(OPEN_MARKER))!;
      let recentComment = comments.find((c) => c.body.includes(RECENT_MARKER))!;

      expect(openComment.body).not.toContain('#10');
      expect(openComment.body).toContain('#20');
      expect(recentComment.body).toContain('#10');

      // Step 3: Age out (31 days later)
      const futureNow = now + 31 * day;
      await ageOutToArchived(github, owner, repo, issueNumber, token, logger, futureNow);

      comments = await github.listIssueComments(owner, repo, issueNumber, token);
      recentComment = comments.find((c) => c.body.includes(RECENT_MARKER))!;
      const archivedComment = comments.find((c) => c.body.includes(ARCHIVED_MARKER))!;

      // #10 should have aged out to Archived
      expect(recentComment.body).not.toContain('#10');
      expect(archivedComment.body).toContain('- #10 — Fix crash');
      // Labels should be stripped in archived format
      expect(archivedComment.body).not.toContain('[bug]');
    });
  });
});
