import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  formatSummaryComment,
  formatIndividualReviewComment,
  fetchCompletedReviews,
  selectSummaryAgent,
  pushSummaryToAgent,
  triggerSummarization,
  postIndividualReviewsFallback,
} from '../summarization.js';
import type { SummaryReview } from '@opencara/shared';

vi.mock('../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

vi.mock('../github.js', () => ({
  getInstallationToken: vi.fn(),
  postPrComment: vi.fn(),
}));

import { getInstallationToken, postPrComment } from '../github.js';

const mockedGetInstallationToken = vi.mocked(getInstallationToken);
const mockedPostPrComment = vi.mocked(postPrComment);

function createMockSupabase() {
  const calls = {
    from: [] as string[],
    insert: [] as { table: string; data: unknown }[],
    update: [] as { table: string; data: unknown }[],
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let selectResult: any = { data: null, error: null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let singleResult: any = { data: null, error: null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: Record<string, any> = {};

  chain.from = vi.fn((table: string) => {
    calls.from.push(table);
    return chain;
  });
  chain.select = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn((data: unknown) => {
    const table = calls.from[calls.from.length - 1];
    calls.insert.push({ table, data });
    return Promise.resolve({ data: null, error: null });
  });
  chain.update = vi.fn((data: unknown) => {
    const table = calls.from[calls.from.length - 1];
    calls.update.push({ table, data });
    return chain;
  });
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.gte = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn(() => Promise.resolve(singleResult));

  // Make chain thenable
  chain.then = (resolve: (v: unknown) => void, reject?: (r: unknown) => void) =>
    Promise.resolve(selectResult).then(resolve, reject);

  chain._setSelectResult = (result: unknown) => {
    selectResult = result;
  };
  chain._setSingleResult = (result: unknown) => {
    singleResult = result;
  };
  chain._calls = calls;

  return chain;
}

const mockDoFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
const mockEnv = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GITHUB_APP_ID: 'test-app-id',
  GITHUB_APP_PRIVATE_KEY: 'test-key',
  GITHUB_CLIENT_ID: 'test-client',
  GITHUB_CLIENT_SECRET: 'test-secret',
  GITHUB_CLI_CLIENT_ID: 'test-cli-client',
  GITHUB_CLI_CLIENT_SECRET: 'test-cli-secret',
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  AGENT_CONNECTION: {
    idFromName: vi.fn(() => ({ toString: () => 'do-id' })),
    get: vi.fn(() => ({
      fetch: mockDoFetch,
    })),
  },
  TASK_TIMEOUT: {},
};

describe('summarization', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockDoFetch.mockResolvedValue(new Response('OK', { status: 200 }));
  });

  describe('formatSummaryComment', () => {
    it('formats summary with review count', () => {
      const result = formatSummaryComment('Great code overall', 3);
      expect(result).toContain('OpenCara Review Summary');
      expect(result).toContain('3 agents reviewed this PR');
      expect(result).toContain('Great code overall');
      expect(result).toContain('Summarized by');
    });

    it('uses singular for 1 agent', () => {
      const result = formatSummaryComment('LGTM', 1);
      expect(result).toContain('1 agent reviewed this PR');
    });
  });

  describe('formatIndividualReviewComment', () => {
    it('formats approve review', () => {
      const result = formatIndividualReviewComment('gpt-4', 'cursor', 'approve', 'LGTM');
      expect(result).toContain('`gpt-4` / `cursor`');
      expect(result).toContain('\u2705');
      expect(result).toContain('LGTM');
    });

    it('formats request_changes review', () => {
      const result = formatIndividualReviewComment(
        'claude',
        'vscode',
        'request_changes',
        'Fix bugs',
      );
      expect(result).toContain('\u274C');
      expect(result).toContain('request_changes');
      expect(result).toContain('Fix bugs');
    });

    it('formats comment review', () => {
      const result = formatIndividualReviewComment('gemini', 'jetbrains', 'comment', 'Nice');
      expect(result).toContain('\uD83D\uDCAC');
      expect(result).toContain('comment');
    });
  });

  describe('fetchCompletedReviews', () => {
    it('returns mapped reviews from supabase', async () => {
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({
        data: [
          {
            agent_id: 'agent-1',
            review_text: 'LGTM',
            verdict: 'approve',
            agents: { model: 'gpt-4', tool: 'cursor' },
          },
          {
            agent_id: 'agent-2',
            review_text: 'Fix bugs',
            verdict: 'request_changes',
            agents: { model: 'claude', tool: 'vscode' },
          },
        ],
      });

      const reviews = await fetchCompletedReviews(mockSupa as never, 'task-1');
      expect(reviews).toHaveLength(2);
      expect(reviews[0]).toEqual({
        agentId: 'agent-1',
        model: 'gpt-4',
        tool: 'cursor',
        review: 'LGTM',
        verdict: 'approve',
      });
      expect(reviews[1].agentId).toBe('agent-2');
    });

    it('filters out reviews without review_text', async () => {
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({
        data: [
          {
            agent_id: 'agent-1',
            review_text: 'LGTM',
            verdict: 'approve',
            agents: { model: 'gpt-4', tool: 'cursor' },
          },
          {
            agent_id: 'agent-2',
            review_text: null,
            verdict: 'approve',
            agents: { model: 'claude', tool: 'vscode' },
          },
        ],
      });

      const reviews = await fetchCompletedReviews(mockSupa as never, 'task-1');
      expect(reviews).toHaveLength(1);
    });

    it('returns empty array when no data', async () => {
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({ data: null });

      const reviews = await fetchCompletedReviews(mockSupa as never, 'task-1');
      expect(reviews).toHaveLength(0);
    });
  });

  describe('selectSummaryAgent', () => {
    it('selects highest reputation agent not in exclude list', async () => {
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({
        data: [{ id: 'agent-1' }, { id: 'agent-2' }, { id: 'agent-3' }],
      });

      const agentId = await selectSummaryAgent(mockSupa as never, ['agent-1']);
      expect(agentId).toBe('agent-2');
    });

    it('returns null when all agents excluded', async () => {
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({
        data: [{ id: 'agent-1' }],
      });

      const agentId = await selectSummaryAgent(mockSupa as never, ['agent-1']);
      expect(agentId).toBeNull();
    });

    it('returns null when no agents available', async () => {
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({ data: null });

      const agentId = await selectSummaryAgent(mockSupa as never, []);
      expect(agentId).toBeNull();
    });
  });

  describe('pushSummaryToAgent', () => {
    it('sends summary request to agent DO', async () => {
      const reviews: SummaryReview[] = [
        { agentId: 'a1', model: 'gpt-4', tool: 'cursor', review: 'LGTM', verdict: 'approve' },
      ];

      await pushSummaryToAgent(
        mockEnv as never,
        'summary-agent',
        'task-1',
        { url: 'https://github.com/pr/1', number: 1 },
        { owner: 'org', repo: 'repo', prompt: 'Review' },
        reviews,
        300,
      );

      expect(mockEnv.AGENT_CONNECTION.idFromName).toHaveBeenCalledWith('summary-agent');
      expect(mockDoFetch).toHaveBeenCalled();

      const fetchCall = mockDoFetch.mock.calls[0][0] as Request;
      expect(new URL(fetchCall.url).pathname).toBe('/push-summary');

      const body = JSON.parse(await fetchCall.text());
      expect(body.type).toBe('summary_request');
      expect(body.taskId).toBe('task-1');
      expect(body.reviews).toHaveLength(1);
      expect(body.timeout).toBe(300);
    });
  });

  describe('triggerSummarization', () => {
    it('dispatches summary to agent when one is available', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const mockSupa = createMockSupabase();

      // fetchCompletedReviews
      let selectCallCount = 0;
      (mockSupa.then as unknown) = (resolve: (v: unknown) => void) => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // fetchCompletedReviews
          return Promise.resolve({
            data: [
              {
                agent_id: 'agent-1',
                review_text: 'LGTM',
                verdict: 'approve',
                agents: { model: 'gpt-4', tool: 'cursor' },
              },
            ],
          }).then(resolve);
        }
        if (selectCallCount === 2) {
          // selectSummaryAgent
          return Promise.resolve({
            data: [{ id: 'summary-agent' }],
          }).then(resolve);
        }
        return Promise.resolve({ data: null }).then(resolve);
      };

      // single for timeout_at lookup
      (mockSupa.single as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { timeout_at: new Date(Date.now() + 300_000).toISOString() },
      });

      const result = await triggerSummarization(mockEnv as never, mockSupa as never, 'task-1', {
        minCount: 1,
        installationId: 99,
        owner: 'org',
        repo: 'repo',
        prNumber: 42,
        prompt: 'Review',
      });

      expect(result).toBe(true);
      expect(mockDoFetch).toHaveBeenCalled();
    });

    it('falls back to individual reviews when no summary agent', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockedGetInstallationToken.mockResolvedValue('token');
      mockedPostPrComment.mockResolvedValue('https://github.com/comment');

      const mockSupa = createMockSupabase();

      let selectCallCount = 0;
      (mockSupa.then as unknown) = (resolve: (v: unknown) => void) => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return Promise.resolve({
            data: [
              {
                agent_id: 'agent-1',
                review_text: 'LGTM',
                verdict: 'approve',
                agents: { model: 'gpt-4', tool: 'cursor' },
              },
            ],
          }).then(resolve);
        }
        if (selectCallCount === 2) {
          // No agents available for summary
          return Promise.resolve({ data: [] }).then(resolve);
        }
        return Promise.resolve({ data: null }).then(resolve);
      };

      const result = await triggerSummarization(mockEnv as never, mockSupa as never, 'task-1', {
        minCount: 1,
        installationId: 99,
        owner: 'org',
        repo: 'repo',
        prNumber: 42,
        prompt: 'Review',
      });

      expect(result).toBe(false);
      expect(mockedPostPrComment).toHaveBeenCalled();
    });

    it('returns false when no completed reviews', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({ data: [] });

      const result = await triggerSummarization(mockEnv as never, mockSupa as never, 'task-1', {
        minCount: 1,
        installationId: 99,
        owner: 'org',
        repo: 'repo',
        prNumber: 42,
        prompt: 'Review',
      });

      expect(result).toBe(false);
    });

    it('falls back when summary push fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockedGetInstallationToken.mockResolvedValue('token');
      mockedPostPrComment.mockResolvedValue('https://github.com/comment');
      mockDoFetch.mockRejectedValue(new Error('DO push failed'));

      const mockSupa = createMockSupabase();

      let selectCallCount = 0;
      (mockSupa.then as unknown) = (resolve: (v: unknown) => void) => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return Promise.resolve({
            data: [
              {
                agent_id: 'agent-1',
                review_text: 'LGTM',
                verdict: 'approve',
                agents: { model: 'gpt-4', tool: 'cursor' },
              },
            ],
          }).then(resolve);
        }
        if (selectCallCount === 2) {
          return Promise.resolve({ data: [{ id: 'summary-agent' }] }).then(resolve);
        }
        return Promise.resolve({ data: null }).then(resolve);
      };

      (mockSupa.single as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { timeout_at: new Date(Date.now() + 300_000).toISOString() },
      });

      const result = await triggerSummarization(mockEnv as never, mockSupa as never, 'task-1', {
        minCount: 1,
        installationId: 99,
        owner: 'org',
        repo: 'repo',
        prNumber: 42,
        prompt: 'Review',
      });

      expect(result).toBe(false);
      // Fell back to individual reviews
      expect(mockedPostPrComment).toHaveBeenCalled();
    });
  });

  describe('postIndividualReviewsFallback', () => {
    it('posts each review as a standalone comment', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockedGetInstallationToken.mockResolvedValue('token');
      mockedPostPrComment.mockResolvedValue('https://github.com/comment');

      const mockSupa = createMockSupabase();
      const reviews: SummaryReview[] = [
        { agentId: 'a1', model: 'gpt-4', tool: 'cursor', review: 'LGTM', verdict: 'approve' },
        {
          agentId: 'a2',
          model: 'claude',
          tool: 'vscode',
          review: 'Fix bugs',
          verdict: 'request_changes',
        },
      ];

      await postIndividualReviewsFallback(
        mockEnv as never,
        mockSupa as never,
        'task-1',
        {
          minCount: 2,
          installationId: 99,
          owner: 'org',
          repo: 'repo',
          prNumber: 42,
          prompt: 'Review',
        },
        reviews,
      );

      expect(mockedGetInstallationToken).toHaveBeenCalledWith(99, mockEnv);
      expect(mockedPostPrComment).toHaveBeenCalledTimes(2);
      // Task transitioned to completed
      expect(mockSupa._calls.update).toContainEqual({
        table: 'review_tasks',
        data: { status: 'completed' },
      });
    });

    it('handles token error gracefully', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mockedGetInstallationToken.mockRejectedValue(new Error('Token error'));

      const mockSupa = createMockSupabase();
      const reviews: SummaryReview[] = [
        { agentId: 'a1', model: 'gpt-4', tool: 'cursor', review: 'LGTM', verdict: 'approve' },
      ];

      await postIndividualReviewsFallback(
        mockEnv as never,
        mockSupa as never,
        'task-1',
        {
          minCount: 1,
          installationId: 99,
          owner: 'org',
          repo: 'repo',
          prNumber: 42,
          prompt: 'Review',
        },
        reviews,
      );

      // Should not throw
      expect(mockedPostPrComment).not.toHaveBeenCalled();
    });
  });
});
