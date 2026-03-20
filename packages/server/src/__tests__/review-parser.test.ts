import { describe, it, expect } from 'vitest';
import { parseStructuredReview, parseDiffFiles, filterValidComments } from '../review-parser.js';

describe('parseStructuredReview', () => {
  it('parses a full structured review', () => {
    const text = `## Summary
This PR looks good overall.

## Findings
- **[minor]** \`src/index.ts:5\` — unused import

## Verdict
APPROVE`;

    const result = parseStructuredReview(text);
    expect(result.summary).toBe('This PR looks good overall.');
    expect(result.verdict).toBe('approve');
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].path).toBe('src/index.ts');
    expect(result.comments[0].line).toBe(5);
  });

  it('falls back to full text when no sections', () => {
    const text = 'Just a plain text review with no structure.';
    const result = parseStructuredReview(text);
    expect(result.summary).toBe(text);
    expect(result.verdict).toBeNull();
    expect(result.comments).toHaveLength(0);
  });

  it('handles REQUEST_CHANGES verdict', () => {
    const text = `## Summary
Needs fixes.

## Verdict
REQUEST_CHANGES`;
    const result = parseStructuredReview(text);
    expect(result.verdict).toBe('request_changes');
  });

  it('skips findings with line number 0', () => {
    const text = `## Summary
Zero line.

## Findings
- **[minor]** \`src/index.ts:0\` — invalid line

## Verdict
APPROVE`;

    const result = parseStructuredReview(text);
    expect(result.comments).toHaveLength(0);
  });

  it('skips findings with negative line numbers', () => {
    const text = `## Summary
Negative line.

## Findings
- **[minor]** \`src/index.ts:-5\` — negative line

## Verdict
APPROVE`;

    const result = parseStructuredReview(text);
    expect(result.comments).toHaveLength(0);
  });

  it('skips synthesizer findings with line number 0', () => {
    const text = `## Summary
Zero line heading.

## Findings

### [major] \`app.ts:0\` — Invalid line
Should be skipped.

## Verdict
COMMENT`;

    const result = parseStructuredReview(text);
    expect(result.comments).toHaveLength(0);
  });

  it('skips synthesizer findings with negative line numbers', () => {
    const text = `## Summary
Negative line heading.

## Findings

### [major] \`app.ts:-3\` — Negative line
Should be skipped.

## Verdict
COMMENT`;

    const result = parseStructuredReview(text);
    expect(result.comments).toHaveLength(0);
  });

  it('parses synthesizer format (### headings)', () => {
    const text = `## Summary
Overview here.

## Findings

### [major] \`app.ts:10\` — Missing null check
The function doesn't check for null input.

### [minor] \`lib.ts:20\` — Consider using const
Variable is never reassigned.

## Verdict
COMMENT`;

    const result = parseStructuredReview(text);
    expect(result.comments).toHaveLength(2);
    expect(result.comments[0].path).toBe('app.ts');
    expect(result.comments[1].path).toBe('lib.ts');
  });
});

describe('parseDiffFiles', () => {
  it('extracts file paths from diff', () => {
    const diff = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
diff --git a/dev/null b/new-file.ts
--- /dev/null
+++ b/new-file.ts`;

    const files = parseDiffFiles(diff);
    expect(files.has('src/index.ts')).toBe(true);
    expect(files.has('new-file.ts')).toBe(true);
  });
});

describe('filterValidComments', () => {
  it('keeps comments whose path is in the diff', () => {
    const comments = [
      { path: 'src/a.ts', line: 1, side: 'RIGHT' as const, body: 'issue' },
      { path: 'src/b.ts', line: 1, side: 'RIGHT' as const, body: 'issue' },
    ];
    const diffFiles = new Set(['src/a.ts']);
    const valid = filterValidComments(comments, diffFiles);
    expect(valid).toHaveLength(1);
    expect(valid[0].path).toBe('src/a.ts');
  });
});
