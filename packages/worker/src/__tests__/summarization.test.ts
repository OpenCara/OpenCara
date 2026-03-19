import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  formatSummaryComment,
  formatIndividualReviewComment,
  fetchCompletedReviews,
  fetchReviewAgents,
  selectSummaryAgent,
  pushSummaryToAgent,
  triggerSummarization,
  retrySummarization,
  postIndividualReviewsFallback,
  MAX_SUMMARY_ATTEMPTS,
  type ReviewAgentInfo,
} from '../summarization.js';
import type { SummaryReview } from '@opencara/shared';

vi.mock('../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

vi.mock('../github.js', () => ({
  getInstallationToken: vi.fn(),
  fetchPrDiff: vi.fn(),
  postPrComment: vi.fn(),
  postPrReview: vi.fn(),
  verdictToReviewEvent: vi.fn((v: string) => {
    const map: Record<string, string> = {
      approve: 'APPROVE',
      request_changes: 'REQUEST_CHANGES',
      comment: 'COMMENT',
    };
    return map[v] ?? 'COMMENT';
  }),
}));

import { getInstallationToken, postPrReview } from '../github.js';
import { fetchPrDiff } from '../github.js';

const mockedGetInstallationToken = vi.mocked(getInstallationToken);
const mockedPostPrReview = vi.mocked(postPrReview);
const mockedFetchPrDiff = vi.mocked(fetchPrDiff);

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
  chain.in = vi.fn().mockReturnValue(chain);
  chain.not = vi.fn().mockReturnValue(chain);
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
    it('formats summary with agent details and synthesizer', () => {
      const agents: ReviewAgentInfo[] = [
        { model: 'claude-sonnet-4-6', tool: 'claude' },
        { model: 'qwen3.5-plus', tool: 'qwen' },
      ];
      const synth: ReviewAgentInfo = { model: 'claude-sonnet-4-6', tool: 'claude' };
      const result = formatSummaryComment('Great code overall', agents, synth);
      expect(result).toContain('OpenCara Review');
      expect(result).toContain(
        '**Agents**: `claude-sonnet-4-6/claude`, `qwen3.5-plus/qwen` (synthesized by `claude-sonnet-4-6/claude`)',
      );
      expect(result).toContain('Great code overall');
      expect(result).toContain('Reviewed by');
    });

    it('formats with no synthesizer when null', () => {
      const agents: ReviewAgentInfo[] = [{ model: 'gpt-4', tool: 'cursor' }];
      const result = formatSummaryComment('LGTM', agents, null);
      expect(result).toContain('**Agents**: `gpt-4/cursor`');
      expect(result).not.toContain('synthesized by');
    });

    it('shows only synthesizer when no reviewers', () => {
      const synth: ReviewAgentInfo = { model: 'claude', tool: 'vscode' };
      const result = formatSummaryComment('Summary', [], synth);
      expect(result).toContain('**Agents**: `claude/vscode`');
      expect(result).not.toContain('synthesized by');
    });

    it('shows no agents line when both empty', () => {
      const result = formatSummaryComment('Summary', [], null);
      expect(result).not.toContain('**Agents**');
    });

    it('includes displayName in agent labels when set', () => {
      const agents: ReviewAgentInfo[] = [
        { model: 'claude-sonnet-4-6', tool: 'claude', displayName: 'My Bot' },
        { model: 'qwen3.5-plus', tool: 'qwen' },
      ];
      const result = formatSummaryComment('Great code', agents, null);
      expect(result).toContain('My Bot (`claude-sonnet-4-6/claude`)');
      expect(result).toContain('`qwen3.5-plus/qwen`');
      // The one without displayName should not have parentheses
      expect(result).not.toContain('(`qwen3.5-plus/qwen`)');
    });

    it('includes displayName in synthesizer label', () => {
      const agents: ReviewAgentInfo[] = [{ model: 'gpt-4', tool: 'cursor' }];
      const synth: ReviewAgentInfo = {
        model: 'claude-sonnet-4-6',
        tool: 'claude',
        displayName: 'Synth Bot',
      };
      const result = formatSummaryComment('Summary', agents, synth);
      expect(result).toContain('synthesized by Synth Bot (`claude-sonnet-4-6/claude`)');
    });

    it('includes multiple contributors', () => {
      const agents: ReviewAgentInfo[] = [{ model: 'gpt-4', tool: 'cursor' }];
      const result = formatSummaryComment('Summary', agents, null, ['alice', 'bob']);
      expect(result).toContain(
        '**Contributors**: [@alice](https://github.com/alice), [@bob](https://github.com/bob)',
      );
    });

    it('handles anonymous contributor in list', () => {
      const agents: ReviewAgentInfo[] = [{ model: 'gpt-4', tool: 'cursor' }];
      const result = formatSummaryComment('Summary', agents, null, [
        'Anonymous contributor',
        'bob',
      ]);
      expect(result).toContain('Anonymous contributor');
      expect(result).toContain('[@bob](https://github.com/bob)');
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
            verdict: 'approve',
            agents: { model: 'gpt-4', tool: 'cursor' },
          },
          {
            agent_id: 'agent-2',
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
        review: '', // review_text no longer stored in DB
        verdict: 'approve',
      });
      expect(reviews[1].agentId).toBe('agent-2');
    });

    it('returns all reviews (review_text no longer stored)', async () => {
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({
        data: [
          {
            agent_id: 'agent-1',
            verdict: 'approve',
            agents: { model: 'gpt-4', tool: 'cursor' },
          },
          {
            agent_id: 'agent-2',
            verdict: 'approve',
            agents: { model: 'claude', tool: 'vscode' },
          },
        ],
      });

      const reviews = await fetchCompletedReviews(mockSupa as never, 'task-1');
      // All reviews returned since review_text filtering was removed
      expect(reviews).toHaveLength(2);
    });

    it('returns empty array when no data', async () => {
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({ data: null });

      const reviews = await fetchCompletedReviews(mockSupa as never, 'task-1');
      expect(reviews).toHaveLength(0);
    });
  });

  describe('fetchReviewAgents', () => {
    it('returns reviewers and synthesizer separately', async () => {
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({
        data: [
          { type: 'review', agents: { model: 'gpt-4', tool: 'cursor' } },
          { type: 'review', agents: { model: 'claude', tool: 'vscode' } },
          { type: 'summary', agents: { model: 'claude-sonnet-4-6', tool: 'claude' } },
        ],
      });

      const result = await fetchReviewAgents(mockSupa as never, 'task-1');
      expect(result.reviewers).toHaveLength(2);
      expect(result.reviewers[0]).toEqual({ model: 'gpt-4', tool: 'cursor' });
      expect(result.reviewers[1]).toEqual({ model: 'claude', tool: 'vscode' });
      expect(result.synthesizer).toEqual({ model: 'claude-sonnet-4-6', tool: 'claude' });
    });

    it('returns null synthesizer when no summary result', async () => {
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({
        data: [{ type: 'review', agents: { model: 'gpt-4', tool: 'cursor' } }],
      });

      const result = await fetchReviewAgents(mockSupa as never, 'task-1');
      expect(result.reviewers).toHaveLength(1);
      expect(result.synthesizer).toBeNull();
    });

    it('returns empty when no data', async () => {
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({ data: null });

      const result = await fetchReviewAgents(mockSupa as never, 'task-1');
      expect(result.reviewers).toHaveLength(0);
      expect(result.synthesizer).toBeNull();
    });

    it('includes displayName when present in agent data', async () => {
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({
        data: [
          {
            type: 'review',
            agents: { model: 'gpt-4', tool: 'cursor', display_name: 'My Bot' },
          },
          { type: 'review', agents: { model: 'claude', tool: 'vscode', display_name: null } },
          {
            type: 'summary',
            agents: { model: 'claude-sonnet-4-6', tool: 'claude', display_name: 'Synth' },
          },
        ],
      });

      const result = await fetchReviewAgents(mockSupa as never, 'task-1');
      expect(result.reviewers[0]).toEqual({
        model: 'gpt-4',
        tool: 'cursor',
        displayName: 'My Bot',
      });
      expect(result.reviewers[1]).toEqual({ model: 'claude', tool: 'vscode' });
      expect(result.synthesizer).toEqual({
        model: 'claude-sonnet-4-6',
        tool: 'claude',
        displayName: 'Synth',
      });
    });
  });

  describe('selectSummaryAgent', () => {
    it('selects an agent not in exclude list', async () => {
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({
        data: [
          { id: 'agent-1', reputation_score: 0.9 },
          { id: 'agent-2', reputation_score: 0.5 },
          { id: 'agent-3', reputation_score: 0.3 },
        ],
      });

      const agentId = await selectSummaryAgent(mockSupa as never, ['agent-1']);
      // Should select one of agent-2 or agent-3 (not agent-1)
      expect(agentId).not.toBe('agent-1');
      expect(['agent-2', 'agent-3']).toContain(agentId);
    });

    it('returns null when all agents excluded', async () => {
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({
        data: [{ id: 'agent-1', reputation_score: 0.5 }],
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

    it('returns null when data is empty array', async () => {
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({ data: [] });

      const agentId = await selectSummaryAgent(mockSupa as never, []);
      expect(agentId).toBeNull();
    });

    it('returns the only eligible agent when just one candidate', async () => {
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({
        data: [
          { id: 'agent-1', reputation_score: 0.9 },
          { id: 'agent-2', reputation_score: 0.5 },
        ],
      });

      const agentId = await selectSummaryAgent(mockSupa as never, ['agent-1']);
      expect(agentId).toBe('agent-2');
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
        'diff --git a/file.ts\n+hello',
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
      expect(body.diffContent).toBe('diff --git a/file.ts\n+hello');
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
        reviewCount: 1,
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
      mockedPostPrReview.mockResolvedValue('https://github.com/comment');

      const mockSupa = createMockSupabase();

      let selectCallCount = 0;
      (mockSupa.then as unknown) = (resolve: (v: unknown) => void) => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return Promise.resolve({
            data: [
              {
                agent_id: 'agent-1',
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
        reviewCount: 1,
        installationId: 99,
        owner: 'org',
        repo: 'repo',
        prNumber: 42,
        prompt: 'Review',
      });

      expect(result).toBe(false);
      expect(mockedPostPrReview).toHaveBeenCalled();
    });

    it('returns false when no completed reviews', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockSupa = createMockSupabase();
      mockSupa._setSelectResult({ data: [] });

      const result = await triggerSummarization(mockEnv as never, mockSupa as never, 'task-1', {
        reviewCount: 1,
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
      mockedPostPrReview.mockResolvedValue('https://github.com/comment');
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
        reviewCount: 1,
        installationId: 99,
        owner: 'org',
        repo: 'repo',
        prNumber: 42,
        prompt: 'Review',
      });

      expect(result).toBe(false);
      // Fell back to individual reviews
      expect(mockedPostPrReview).toHaveBeenCalled();
    });
  });

  describe('postIndividualReviewsFallback', () => {
    it('posts each review as a standalone PR review', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockedGetInstallationToken.mockResolvedValue('token');
      mockedPostPrReview.mockResolvedValue('https://github.com/comment');

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
          reviewCount: 2,
          installationId: 99,
          owner: 'org',
          repo: 'repo',
          prNumber: 42,
          prompt: 'Review',
        },
        reviews,
      );

      expect(mockedGetInstallationToken).toHaveBeenCalledWith(99, mockEnv);
      expect(mockedPostPrReview).toHaveBeenCalledTimes(2);
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
          reviewCount: 1,
          installationId: 99,
          owner: 'org',
          repo: 'repo',
          prNumber: 42,
          prompt: 'Review',
        },
        reviews,
      );

      // Should not throw
      expect(mockedPostPrReview).not.toHaveBeenCalled();
    });
  });

  describe('MAX_SUMMARY_ATTEMPTS', () => {
    it('is exported and equals 2', () => {
      expect(MAX_SUMMARY_ATTEMPTS).toBe(2);
    });
  });

  describe('dispatchSummaryToAgent inserts pending status', () => {
    it('inserts review_results with pending status via triggerSummarization', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const mockSupa = createMockSupabase();

      let selectCallCount = 0;
      (mockSupa.then as unknown) = (resolve: (v: unknown) => void) => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // fetchCompletedReviews
          return Promise.resolve({
            data: [
              {
                agent_id: 'agent-1',
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

      (mockSupa.single as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { timeout_at: new Date(Date.now() + 300_000).toISOString() },
      });

      await triggerSummarization(mockEnv as never, mockSupa as never, 'task-1', {
        reviewCount: 1,
        installationId: 99,
        owner: 'org',
        repo: 'repo',
        prNumber: 42,
        prompt: 'Review',
      });

      // Verify insert was called with status: 'pending' (not 'completed')
      const summaryInsert = mockSupa._calls.insert.find(
        (c) =>
          c.table === 'review_results' && (c.data as Record<string, unknown>).type === 'summary',
      );
      expect(summaryInsert).toBeDefined();
      expect((summaryInsert!.data as Record<string, unknown>).status).toBe('pending');
    });
  });

  describe('retrySummarization', () => {
    /**
     * Creates a mock supabase for retrySummarization tests.
     * Supports configuring count results, select results per call order, and single results.
     */
    function createRetryMockSupabase(config: {
      summaryCount: number;
      completedReviews: Record<string, unknown>[];
      failedSummaries: { agent_id: string }[];
      onlineAgents: Record<string, unknown>[];
      timeoutAt?: string;
    }) {
      const calls = {
        from: [] as string[],
        insert: [] as { table: string; data: unknown }[],
        update: [] as { table: string; data: unknown }[],
      };

      let fromCallIndex = 0;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function makeChain(callIdx: number): Record<string, any> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: Record<string, any> = {};

        chain.select = vi.fn((_cols?: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.count === 'exact') {
            // Count query -- first from call is the count for summary attempts
            const countChain: Record<string, unknown> = {};
            countChain.eq = vi.fn().mockReturnValue(countChain);
            countChain.then = (resolve: (v: unknown) => void) =>
              Promise.resolve({ count: config.summaryCount }).then(resolve);
            return countChain;
          }
          return chain;
        });

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
        chain.in = vi.fn().mockReturnValue(chain);

        chain.single = vi.fn(() => {
          return Promise.resolve({
            data: { timeout_at: config.timeoutAt ?? new Date(Date.now() + 300_000).toISOString() },
          });
        });

        // The thenable result depends on which from() call this is.
        // Call pattern for retrySummarization (when count < max):
        //   1. review_results count (handled by select with count option)
        //   2. review_results (fetchCompletedReviews)
        //   3. review_results (failed summaries)
        //   4. agents (selectSummaryAgent)
        //   5. review_results insert (dispatchSummaryToAgent)
        //   6. review_tasks single (dispatchSummaryToAgent timeout)
        chain.then = (resolve: (v: unknown) => void) => {
          // Determine which query this is based on the call index
          if (callIdx === 1) {
            // fetchCompletedReviews
            return Promise.resolve({ data: config.completedReviews }).then(resolve);
          }
          if (callIdx === 2) {
            // failed summaries select
            return Promise.resolve({ data: config.failedSummaries }).then(resolve);
          }
          if (callIdx === 3) {
            // selectSummaryAgent (agents online)
            return Promise.resolve({ data: config.onlineAgents }).then(resolve);
          }
          return Promise.resolve({ data: null }).then(resolve);
        };

        return chain;
      }

      const mock = {
        from: vi.fn((_table: string) => {
          calls.from.push(_table);
          const idx = fromCallIndex++;
          return makeChain(idx);
        }),
        _calls: calls,
      };

      return mock;
    }

    it('retries with a different agent when under max attempts', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockedGetInstallationToken.mockResolvedValue('token');
      mockedFetchPrDiff.mockResolvedValue('diff content');

      const mockSupa = createRetryMockSupabase({
        summaryCount: 1, // 1 attempt so far (under MAX_SUMMARY_ATTEMPTS=2)
        completedReviews: [
          {
            agent_id: 'reviewer-1',
            verdict: 'approve',
            agents: { model: 'gpt-4', tool: 'cursor' },
          },
        ],
        failedSummaries: [{ agent_id: 'failed-synth-1' }],
        onlineAgents: [{ id: 'new-synth', model: 'claude', users: { is_anonymous: false } }],
      });

      const result = await retrySummarization(
        mockEnv as never,
        mockSupa as never,
        'task-1',
        {
          reviewCount: 2,
          installationId: 99,
          owner: 'org',
          repo: 'repo',
          prNumber: 42,
          prompt: 'Review',
        },
        'failed-synth-1',
      );

      expect(result).toBe(true);
      expect(mockDoFetch).toHaveBeenCalled();
    });

    it('falls back to individual reviews after max attempts', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockedGetInstallationToken.mockResolvedValue('token');
      mockedPostPrReview.mockResolvedValue('https://github.com/comment');

      const mockSupa = createRetryMockSupabase({
        summaryCount: 2, // Already at MAX_SUMMARY_ATTEMPTS
        completedReviews: [
          {
            agent_id: 'reviewer-1',
            verdict: 'approve',
            agents: { model: 'gpt-4', tool: 'cursor' },
          },
        ],
        failedSummaries: [],
        onlineAgents: [],
      });

      const result = await retrySummarization(
        mockEnv as never,
        mockSupa as never,
        'task-1',
        {
          reviewCount: 2,
          installationId: 99,
          owner: 'org',
          repo: 'repo',
          prNumber: 42,
          prompt: 'Review',
        },
        'failed-synth-1',
      );

      expect(result).toBe(false);
      // Individual reviews should be posted
      expect(mockedPostPrReview).toHaveBeenCalled();
    });

    it('falls back when no alternative synthesizer is available', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockedGetInstallationToken.mockResolvedValue('token');
      mockedPostPrReview.mockResolvedValue('https://github.com/comment');

      const mockSupa = createRetryMockSupabase({
        summaryCount: 1,
        completedReviews: [
          {
            agent_id: 'reviewer-1',
            verdict: 'approve',
            agents: { model: 'gpt-4', tool: 'cursor' },
          },
        ],
        failedSummaries: [{ agent_id: 'failed-synth-1' }],
        onlineAgents: [], // No agents available
      });

      const result = await retrySummarization(
        mockEnv as never,
        mockSupa as never,
        'task-1',
        {
          reviewCount: 2,
          installationId: 99,
          owner: 'org',
          repo: 'repo',
          prNumber: 42,
          prompt: 'Review',
        },
        'failed-synth-1',
      );

      expect(result).toBe(false);
      expect(mockedPostPrReview).toHaveBeenCalled();
    });

    it('excludes reviewer and failed synthesizer IDs from retry selection', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockedGetInstallationToken.mockResolvedValue('token');
      mockedFetchPrDiff.mockResolvedValue('diff');

      const mockSupa = createRetryMockSupabase({
        summaryCount: 1,
        completedReviews: [
          {
            agent_id: 'reviewer-1',
            verdict: 'approve',
            agents: { model: 'gpt-4', tool: 'cursor' },
          },
        ],
        failedSummaries: [{ agent_id: 'failed-synth-1' }],
        // Only agent that isn't excluded
        onlineAgents: [
          { id: 'reviewer-1', model: 'gpt-4', users: { is_anonymous: false } },
          { id: 'failed-synth-1', model: 'claude', users: { is_anonymous: false } },
          { id: 'new-agent', model: 'gemini', users: { is_anonymous: false } },
        ],
      });

      const result = await retrySummarization(
        mockEnv as never,
        mockSupa as never,
        'task-1',
        {
          reviewCount: 2,
          installationId: 99,
          owner: 'org',
          repo: 'repo',
          prNumber: 42,
          prompt: 'Review',
        },
        'failed-synth-1',
      );

      expect(result).toBe(true);
      // Should dispatch to new-agent (not reviewer-1 or failed-synth-1)
      expect(mockEnv.AGENT_CONNECTION.idFromName).toHaveBeenCalledWith('new-agent');
    });
  });
});
