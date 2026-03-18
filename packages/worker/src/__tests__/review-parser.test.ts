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

  it('parses synthesizer heading format (### [severity] `file:line` — Title)', () => {
    const text = `## Summary
Overall good PR with a few issues to address.

## Findings

### [critical] \`src/auth.ts:42\` — SQL injection vulnerability
The user input is concatenated directly into the query string.
Use parameterized queries instead:
\`\`\`ts
db.query('SELECT * FROM users WHERE id = $1', [userId]);
\`\`\`

### [major] \`src/handler.ts:15\` — Missing error handling
The async call has no try/catch block, which will cause unhandled rejections.

### [minor] \`src/utils.ts:8\` — Unused import
\`lodash\` is imported but never used.

## Verdict
REQUEST_CHANGES`;

    const result = parseStructuredReview(text);
    expect(result.verdict).toBe('request_changes');
    expect(result.summary).toBe('Overall good PR with a few issues to address.');
    expect(result.comments).toHaveLength(3);
    expect(result.comments[0]).toMatchObject({
      path: 'src/auth.ts',
      line: 42,
      side: 'RIGHT',
    });
    expect(result.comments[0].body).toContain('**[critical]**');
    expect(result.comments[0].body).toContain('SQL injection vulnerability');
    expect(result.comments[0].body).toContain('parameterized queries');
    expect(result.comments[1]).toMatchObject({
      path: 'src/handler.ts',
      line: 15,
      side: 'RIGHT',
    });
    expect(result.comments[1].body).toContain('**[major]**');
    expect(result.comments[2]).toMatchObject({
      path: 'src/utils.ts',
      line: 8,
      side: 'RIGHT',
    });
    expect(result.comments[2].body).toContain('**[minor]**');
  });

  it('handles mixed list and heading formats in findings', () => {
    const text = `## Summary
Mixed review.

## Findings
- **[minor]** \`src/a.ts:1\` — List format finding

### [major] \`src/b.ts:10\` — Heading format finding
Detailed explanation here.

## Verdict
COMMENT`;

    const result = parseStructuredReview(text);
    expect(result.comments).toHaveLength(2);
    expect(result.comments[0]).toMatchObject({ path: 'src/a.ts', line: 1 });
    expect(result.comments[1]).toMatchObject({ path: 'src/b.ts', line: 10 });
  });

  it('deduplicates findings matching both formats for same file:line', () => {
    const text = `## Summary
Test

## Findings
- **[major]** \`src/foo.ts:42\` — Duplicate issue

### [major] \`src/foo.ts:42\` — Duplicate issue explained
More detail here.

## Verdict
REQUEST_CHANGES`;

    const result = parseStructuredReview(text);
    // List format is parsed first, heading format skips duplicates
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].path).toBe('src/foo.ts');
    expect(result.comments[0].line).toBe(42);
  });

  it('handles synthesizer heading with suggestion severity', () => {
    const text = `## Summary
LGTM with suggestions.

## Findings

### [suggestion] \`src/config.ts:25\` — Consider using const assertion
Using \`as const\` here would provide better type narrowing.

## Verdict
APPROVE`;

    const result = parseStructuredReview(text);
    expect(result.verdict).toBe('approve');
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toMatchObject({
      path: 'src/config.ts',
      line: 25,
      side: 'RIGHT',
    });
    expect(result.comments[0].body).toContain('**[suggestion]**');
  });

  it('handles heading body containing non-finding ### markdown', () => {
    const text = `## Summary
Test

## Findings

### [major] \`src/foo.ts:10\` — Issue with subheading in body
Explanation here.
### Details
This is a markdown subheading inside the body, not a finding.

### [minor] \`src/bar.ts:20\` — Second finding
Simple issue.

## Verdict
REQUEST_CHANGES`;

    const result = parseStructuredReview(text);
    expect(result.comments).toHaveLength(2);
    expect(result.comments[0]).toMatchObject({ path: 'src/foo.ts', line: 10 });
    expect(result.comments[0].body).toContain('Details');
    expect(result.comments[0].body).toContain('subheading inside the body');
    expect(result.comments[1]).toMatchObject({ path: 'src/bar.ts', line: 20 });
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
