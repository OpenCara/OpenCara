import { describe, it, expect } from 'vitest';
import {
  TRUST_BOUNDARY_BLOCK,
  SEVERITY_RUBRIC_BLOCK,
  LARGE_DIFF_TRIAGE_BLOCK,
  TRIAGE_SYSTEM_PROMPT,
  IMPLEMENT_SYSTEM_PROMPT,
  ISSUE_REVIEW_SYSTEM_PROMPT,
  buildSystemPrompt,
  buildUserMessage,
  buildSummarySystemPrompt,
  buildSummaryUserMessage,
  buildTriagePrompt,
  buildImplementPrompt,
  buildFixPrompt,
  buildDedupPrompt,
  buildIndexEntryPrompt,
  buildIssueReviewPrompt,
} from '../prompts.js';
import type { PollTask } from '@opencara/shared';

// ── Shared Blocks ────────────────────────────────────────────────

describe('TRUST_BOUNDARY_BLOCK', () => {
  it('contains trust level definitions', () => {
    expect(TRUST_BOUNDARY_BLOCK).toContain('Trust Boundaries');
    expect(TRUST_BOUNDARY_BLOCK).toContain('Trusted');
    expect(TRUST_BOUNDARY_BLOCK).toContain('Untrusted');
    expect(TRUST_BOUNDARY_BLOCK).toContain('prompt injection');
  });
});

describe('SEVERITY_RUBRIC_BLOCK', () => {
  it('contains severity levels', () => {
    expect(SEVERITY_RUBRIC_BLOCK).toContain('critical');
    expect(SEVERITY_RUBRIC_BLOCK).toContain('major');
    expect(SEVERITY_RUBRIC_BLOCK).toContain('minor');
    expect(SEVERITY_RUBRIC_BLOCK).toContain('suggestion');
  });
});

describe('LARGE_DIFF_TRIAGE_BLOCK', () => {
  it('contains large diff instructions', () => {
    expect(LARGE_DIFF_TRIAGE_BLOCK).toContain('Large Diff Triage');
    expect(LARGE_DIFF_TRIAGE_BLOCK).toContain('500 lines');
  });
});

// ── buildSystemPrompt ────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  it('defaults to full mode', () => {
    const prompt = buildSystemPrompt('owner', 'repo');
    expect(prompt).toContain('owner/repo');
    expect(prompt).toContain('APPROVE | REQUEST_CHANGES | COMMENT');
    expect(prompt).not.toContain('Blocking issues');
  });

  it('produces full review format', () => {
    const prompt = buildSystemPrompt('acme', 'widgets', 'full');
    expect(prompt).toContain('acme/widgets');
    expect(prompt).toContain('## Verdict');
  });

  it('produces compact review format', () => {
    const prompt = buildSystemPrompt('acme', 'widgets', 'compact');
    expect(prompt).toContain('acme/widgets');
    expect(prompt).toContain('Blocking issues');
    expect(prompt).toContain('Review confidence');
  });

  it('substitutes owner and repo', () => {
    const prompt = buildSystemPrompt('myorg', 'myrepo');
    expect(prompt).toContain('myorg/myrepo');
  });
});

// ── buildUserMessage ─────────────────────────────────────────────

describe('buildUserMessage', () => {
  it('wraps prompt and diff in delimiters', () => {
    const msg = buildUserMessage('review carefully', 'diff content');
    expect(msg).toContain('BEGIN REPOSITORY REVIEW INSTRUCTIONS');
    expect(msg).toContain('review carefully');
    expect(msg).toContain('BEGIN CODE DIFF');
    expect(msg).toContain('diff content');
  });

  it('includes context block when provided', () => {
    const msg = buildUserMessage('prompt', 'diff', 'context info');
    expect(msg).toContain('context info');
  });

  it('omits context block when not provided', () => {
    const msg = buildUserMessage('prompt', 'diff');
    expect(msg).not.toContain('context info');
  });
});

// ── buildSummarySystemPrompt ─────────────────────────────────────

describe('buildSummarySystemPrompt', () => {
  it('uses singular "review" for count=1', () => {
    const prompt = buildSummarySystemPrompt('owner', 'repo', 1);
    expect(prompt).toContain('1 review from other agents');
  });

  it('uses plural "reviews" for count>1', () => {
    const prompt = buildSummarySystemPrompt('owner', 'repo', 3);
    expect(prompt).toContain('3 reviews from other agents');
  });

  it('includes adversarial verifier instructions', () => {
    const prompt = buildSummarySystemPrompt('owner', 'repo', 2);
    expect(prompt).toContain('Adversarial Verifier');
    expect(prompt).toContain('owner/repo');
    expect(prompt).toContain('Flagged Reviews');
    expect(prompt).toContain('Agent Attribution');
  });
});

// ── buildSummaryUserMessage ──────────────────────────────────────

describe('buildSummaryUserMessage', () => {
  it('includes review sections from all agents', () => {
    const reviews = [
      {
        agentId: 'agent-1',
        model: 'claude',
        tool: 'cli',
        review: 'review text 1',
        verdict: 'approve',
      },
      {
        agentId: 'agent-2',
        model: 'gemini',
        tool: 'cli',
        review: 'review text 2',
        verdict: 'comment',
      },
    ];
    const msg = buildSummaryUserMessage('prompt', reviews, 'diff content');
    expect(msg).toContain('agent-1');
    expect(msg).toContain('review text 1');
    expect(msg).toContain('agent-2');
    expect(msg).toContain('review text 2');
    expect(msg).toContain('Compact reviews from other agents');
  });

  it('includes verdict in review header', () => {
    const reviews = [
      { agentId: 'agent-1', model: 'claude', tool: 'cli', review: 'text', verdict: 'approve' },
    ];
    const msg = buildSummaryUserMessage('prompt', reviews, 'diff');
    expect(msg).toContain('Verdict: approve');
  });

  it('includes context block when provided', () => {
    const msg = buildSummaryUserMessage('prompt', [], 'diff', 'extra context');
    expect(msg).toContain('extra context');
  });
});

// ── TRIAGE_SYSTEM_PROMPT ─────────────────────────────────────────

describe('TRIAGE_SYSTEM_PROMPT', () => {
  it('contains triage instructions', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('triage agent');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('category');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('UNTRUSTED');
  });
});

// ── buildTriagePrompt ────────────────────────────────────────────

describe('buildTriagePrompt', () => {
  const baseTask: PollTask = {
    task_id: 'task-1',
    pr_number: 42,
    owner: 'org',
    repo: 'project',
    diff_url: 'https://github.com/org/project/pull/42.diff',
    role: 'issue_triage',
  };

  it('uses issue title when available', () => {
    const prompt = buildTriagePrompt({ ...baseTask, issue_title: 'Fix bug' });
    expect(prompt).toContain('Fix bug');
  });

  it('falls back to PR number when no title', () => {
    const prompt = buildTriagePrompt(baseTask);
    expect(prompt).toContain('PR #42');
  });

  it('includes issue body in untrusted content tags', () => {
    const prompt = buildTriagePrompt({ ...baseTask, issue_body: 'body text' });
    expect(prompt).toContain('<UNTRUSTED_CONTENT>');
    expect(prompt).toContain('body text');
  });

  it('truncates large bodies', () => {
    const bigBody = 'a'.repeat(11 * 1024); // > 10KB
    const prompt = buildTriagePrompt({ ...baseTask, issue_body: bigBody });
    expect(prompt).toContain('truncated');
  });

  it('includes repo-specific prompt when provided', () => {
    const prompt = buildTriagePrompt({ ...baseTask, prompt: 'custom instructions' });
    expect(prompt).toContain('Repo-Specific Instructions');
    expect(prompt).toContain('custom instructions');
  });
});

// ── IMPLEMENT_SYSTEM_PROMPT ──────────────────────────────────────

describe('IMPLEMENT_SYSTEM_PROMPT', () => {
  it('contains implementation instructions', () => {
    expect(IMPLEMENT_SYSTEM_PROMPT).toContain('implementation agent');
    expect(IMPLEMENT_SYSTEM_PROMPT).toContain('UNTRUSTED');
  });
});

// ── buildImplementPrompt ─────────────────────────────────────────

describe('buildImplementPrompt', () => {
  const baseTask: PollTask = {
    task_id: 'task-1',
    pr_number: 10,
    owner: 'org',
    repo: 'project',
    diff_url: 'https://github.com/org/project/pull/10.diff',
    role: 'implement',
  };

  it('uses issue number from issue_number field', () => {
    const prompt = buildImplementPrompt({ ...baseTask, issue_number: 99, issue_title: 'My issue' });
    expect(prompt).toContain('#99');
    expect(prompt).toContain('My issue');
  });

  it('falls back to pr_number when no issue_number', () => {
    const prompt = buildImplementPrompt(baseTask);
    expect(prompt).toContain('#10');
  });

  it('includes body with truncation for large content', () => {
    const bigBody = 'x'.repeat(31 * 1024); // > 30KB
    const prompt = buildImplementPrompt({ ...baseTask, issue_body: bigBody });
    expect(prompt).toContain('truncated');
  });

  it('includes repo-specific instructions', () => {
    const prompt = buildImplementPrompt({ ...baseTask, prompt: 'special rules' });
    expect(prompt).toContain('Repo-Specific Instructions');
    expect(prompt).toContain('special rules');
  });
});

// ── buildFixPrompt ───────────────────────────────────────────────

describe('buildFixPrompt', () => {
  const baseTask = {
    owner: 'org',
    repo: 'project',
    prNumber: 5,
    diffContent: 'diff here',
    prReviewComments: 'fix this',
  };

  it('includes repo and PR info', () => {
    const prompt = buildFixPrompt(baseTask);
    expect(prompt).toContain('org/project');
    expect(prompt).toContain('PR #5');
  });

  it('includes diff content', () => {
    const prompt = buildFixPrompt(baseTask);
    expect(prompt).toContain('diff here');
  });

  it('includes review comments', () => {
    const prompt = buildFixPrompt(baseTask);
    expect(prompt).toContain('fix this');
  });

  it('includes custom prompt when provided', () => {
    const prompt = buildFixPrompt({ ...baseTask, customPrompt: 'project rules' });
    expect(prompt).toContain('Repo-Specific Instructions');
    expect(prompt).toContain('project rules');
  });

  it('omits custom prompt section when not provided', () => {
    const prompt = buildFixPrompt(baseTask);
    expect(prompt).not.toContain('Repo-Specific Instructions');
  });
});

// ── buildDedupPrompt ─────────────────────────────────────────────

describe('buildDedupPrompt', () => {
  const baseTask = {
    owner: 'org',
    repo: 'project',
    pr_number: 3,
    diff_url: 'https://example.com/diff',
  };

  it('includes repo info', () => {
    const prompt = buildDedupPrompt(baseTask);
    expect(prompt).toContain('org/project');
    expect(prompt).toContain('duplicate detection agent');
  });

  it('includes index body when provided', () => {
    const prompt = buildDedupPrompt({ ...baseTask, index_issue_body: 'existing items' });
    expect(prompt).toContain('existing items');
  });

  it('shows empty index when no body provided', () => {
    const prompt = buildDedupPrompt(baseTask);
    expect(prompt).toContain('empty index');
  });

  it('includes issue title and body', () => {
    const prompt = buildDedupPrompt({
      ...baseTask,
      issue_title: 'Fix bug',
      issue_body: 'description',
    });
    expect(prompt).toContain('Fix bug');
    expect(prompt).toContain('description');
  });

  it('includes diff content when provided', () => {
    const prompt = buildDedupPrompt({ ...baseTask, diffContent: 'changed lines' });
    expect(prompt).toContain('changed lines');
    expect(prompt).toContain('Diff Content');
  });

  it('includes custom prompt when provided', () => {
    const prompt = buildDedupPrompt({ ...baseTask, customPrompt: 'special rules' });
    expect(prompt).toContain('Repo-Specific Instructions');
    expect(prompt).toContain('special rules');
  });
});

// ── buildIndexEntryPrompt ────────────────────────────────────────

describe('buildIndexEntryPrompt', () => {
  const prItem = {
    number: 42,
    title: 'Add feature X',
    state: 'open',
    labels: [{ name: 'enhancement' }, { name: 'cli' }],
    closed_at: null,
  };

  it('generates PR prompt with correct type label', () => {
    const prompt = buildIndexEntryPrompt(prItem, 'prs');
    expect(prompt).toContain('PR');
    expect(prompt).toContain('#42');
    expect(prompt).toContain('Add feature X');
    expect(prompt).toContain('enhancement, cli');
    expect(prompt).toContain('open');
  });

  it('generates Issue prompt with correct type label', () => {
    const issueItem = { ...prItem, number: 10, title: 'Bug report' };
    const prompt = buildIndexEntryPrompt(issueItem, 'issues');
    expect(prompt).toContain('Issue');
    expect(prompt).toContain('#10');
    expect(prompt).toContain('Bug report');
  });

  it('handles empty labels', () => {
    const noLabels = { ...prItem, labels: [] };
    const prompt = buildIndexEntryPrompt(noLabels, 'prs');
    expect(prompt).toContain('(none)');
  });

  it('requests description under 120 characters', () => {
    const prompt = buildIndexEntryPrompt(prItem, 'prs');
    expect(prompt).toContain('120 characters');
  });
});

// ── ISSUE_REVIEW_SYSTEM_PROMPT ──────────────────────────────────

describe('ISSUE_REVIEW_SYSTEM_PROMPT', () => {
  it('contains review criteria', () => {
    expect(ISSUE_REVIEW_SYSTEM_PROMPT).toContain('quality reviewer');
    expect(ISSUE_REVIEW_SYSTEM_PROMPT).toContain('Clarity');
    expect(ISSUE_REVIEW_SYSTEM_PROMPT).toContain('Completeness');
    expect(ISSUE_REVIEW_SYSTEM_PROMPT).toContain('Actionability');
    expect(ISSUE_REVIEW_SYSTEM_PROMPT).toContain('UNTRUSTED');
  });
});

// ── buildIssueReviewPrompt ──────────────────────────────────────

describe('buildIssueReviewPrompt', () => {
  const baseTask: PollTask = {
    task_id: 'task-1',
    pr_number: 0,
    owner: 'org',
    repo: 'project',
    diff_url: '',
    role: 'issue_review',
    issue_number: 10,
  };

  it('uses issue title when available', () => {
    const prompt = buildIssueReviewPrompt({ ...baseTask, issue_title: 'Fix login' });
    expect(prompt).toContain('Fix login');
  });

  it('falls back to issue number when no title', () => {
    const prompt = buildIssueReviewPrompt(baseTask);
    expect(prompt).toContain('Issue #10');
  });

  it('includes issue body in untrusted content tags', () => {
    const prompt = buildIssueReviewPrompt({ ...baseTask, issue_body: 'body text' });
    expect(prompt).toContain('<UNTRUSTED_CONTENT>');
    expect(prompt).toContain('body text');
  });

  it('truncates large bodies', () => {
    const bigBody = 'a'.repeat(11 * 1024);
    const prompt = buildIssueReviewPrompt({ ...baseTask, issue_body: bigBody });
    expect(prompt).toContain('truncated');
  });

  it('includes repo-specific prompt when provided', () => {
    const prompt = buildIssueReviewPrompt({ ...baseTask, prompt: 'custom instructions' });
    expect(prompt).toContain('Repo-Specific Instructions');
    expect(prompt).toContain('custom instructions');
  });

  it('handles missing body gracefully', () => {
    const prompt = buildIssueReviewPrompt(baseTask);
    expect(prompt).toContain('(no body provided)');
  });
});
