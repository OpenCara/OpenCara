import { describe, it, expect } from 'vitest';
import { parseStructuredReview, parseDiffFiles, filterValidComments } from '../review-parser.js';

describe('parseDiffFiles', () => {
  it('extracts file paths from unified diff', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index 123..456 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
+import bar
diff --git a/src/bar.ts b/src/bar.ts
--- a/src/bar.ts
+++ b/src/bar.ts`;
    const files = parseDiffFiles(diff);
    expect(files).toEqual(new Set(['src/foo.ts', 'src/bar.ts']));
  });

  it('handles new files (a/dev/null)', () => {
    const diff = `diff --git a/dev/null b/src/new-file.ts
--- /dev/null
+++ b/src/new-file.ts`;
    const files = parseDiffFiles(diff);
    expect(files).toEqual(new Set(['src/new-file.ts']));
    expect(files.has('dev/null')).toBe(false);
  });

  it('returns empty set for empty diff', () => {
    expect(parseDiffFiles('')).toEqual(new Set());
  });
});

describe('parseStructuredReview', () => {
  it('parses full structured review with summary, findings, verdict', () => {
    const text = `## Summary
Clean implementation, one edge case to fix.

## Findings
- **[major]** \`src/foo.ts:42\` — Division by zero when count is 0
- **[minor]** \`src/bar.ts:15\` — Unused import

## Verdict
REQUEST_CHANGES`;

    const result = parseStructuredReview(text);
    expect(result.verdict).toBe('request_changes');
    expect(result.summary).toBe('Clean implementation, one edge case to fix.');
    expect(result.comments).toHaveLength(2);
    expect(result.comments[0]).toEqual({
      path: 'src/foo.ts',
      line: 42,
      side: 'RIGHT',
      body: '**[major]** Division by zero when count is 0',
    });
    expect(result.comments[1]).toEqual({
      path: 'src/bar.ts',
      line: 15,
      side: 'RIGHT',
      body: '**[minor]** Unused import',
    });
  });

  it('parses APPROVE verdict', () => {
    const text = `## Summary
LGTM

## Findings
No issues found.

## Verdict
APPROVE`;
    const result = parseStructuredReview(text);
    expect(result.verdict).toBe('approve');
    expect(result.comments).toHaveLength(0);
  });

  it('falls back to full text when no structured sections', () => {
    const text = 'Just a plain review with no structure.';
    const result = parseStructuredReview(text);
    expect(result.summary).toBe(text);
    expect(result.verdict).toBeNull();
    expect(result.comments).toHaveLength(0);
  });

  it('handles verdict without findings section', () => {
    const text = `## Summary
Looks good.

## Verdict
COMMENT`;
    const result = parseStructuredReview(text);
    expect(result.verdict).toBe('comment');
    expect(result.summary).toBe('Looks good.');
    expect(result.comments).toHaveLength(0);
  });

  it('handles nested directory paths', () => {
    const text = `## Summary
Test

## Findings
- **[critical]** \`packages/worker/src/agent-connection.ts:100\` — Missing null check

## Verdict
REQUEST_CHANGES`;
    const result = parseStructuredReview(text);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].path).toBe('packages/worker/src/agent-connection.ts');
    expect(result.comments[0].line).toBe(100);
  });
});

describe('filterValidComments', () => {
  it('keeps comments whose path exists in diff', () => {
    const diffFiles = new Set(['src/foo.ts', 'src/bar.ts']);
    const comments = [
      { path: 'src/foo.ts', line: 42, body: 'bug' },
      { path: 'src/baz.ts', line: 10, body: 'not in diff' },
      { path: 'src/bar.ts', line: 15, body: 'valid' },
    ];
    const valid = filterValidComments(comments, diffFiles);
    expect(valid).toHaveLength(2);
    expect(valid.map((c) => c.path)).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('returns empty for no matching files', () => {
    const diffFiles = new Set(['other.ts']);
    const comments = [{ path: 'src/foo.ts', line: 1, body: 'test' }];
    expect(filterValidComments(comments, diffFiles)).toHaveLength(0);
  });
});
