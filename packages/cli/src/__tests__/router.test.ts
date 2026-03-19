import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { RouterRelay, RouterTimeoutError, END_OF_RESPONSE } from '../router.js';

function createTestRelay(): {
  relay: RouterRelay;
  stdin: PassThrough;
  stdoutChunks: string[];
  stderrChunks: string[];
} {
  const stdin = new PassThrough();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const stdout = {
    write: (data: string) => {
      stdoutChunks.push(data);
    },
  };
  const stderr = {
    write: (data: string) => {
      stderrChunks.push(data);
    },
  };

  const relay = new RouterRelay({ stdin, stdout, stderr });
  return { relay, stdin, stdoutChunks, stderrChunks };
}

describe('RouterRelay', () => {
  let relay: RouterRelay;
  let stdin: PassThrough;
  let stdoutChunks: string[];
  let stderrChunks: string[];

  beforeEach(() => {
    ({ relay, stdin, stdoutChunks, stderrChunks } = createTestRelay());
  });

  afterEach(() => {
    relay.stop();
    stdin.destroy();
  });

  describe('writePrompt', () => {
    it('writes plain text to stdout', () => {
      relay.writePrompt('Review this code');

      expect(stdoutChunks).toHaveLength(1);
      expect(stdoutChunks[0]).toBe('Review this code\n');
    });
  });

  describe('writeStatus', () => {
    it('writes status to stderr', () => {
      relay.writeStatus('Waiting for review requests...');

      expect(stderrChunks).toHaveLength(1);
      expect(stderrChunks[0]).toBe('Waiting for review requests...\n');
    });
  });

  describe('sendPrompt', () => {
    it('writes prompt to stdout and resolves on END_OF_RESPONSE', async () => {
      relay.start();

      const responsePromise = relay.sendPrompt('review_request', 'task-1', 'Review this code', 300);

      expect(stdoutChunks).toHaveLength(1);
      expect(stdoutChunks[0]).toBe('Review this code\n');

      // Send response via stdin, terminated by END_OF_RESPONSE
      stdin.write('LGTM\n');
      stdin.write('\n');
      stdin.write('## Verdict\n');
      stdin.write('APPROVE\n');
      stdin.write(END_OF_RESPONSE + '\n');

      const result = await responsePromise;
      expect(result).toBe('LGTM\n\n## Verdict\nAPPROVE');
      expect(relay.pendingCount).toBe(0);
    });

    it('resolves on stdin EOF', async () => {
      relay.start();

      const responsePromise = relay.sendPrompt('review_request', 'task-1', 'Review this', 300);

      stdin.write('Review text\n');
      stdin.end();

      const result = await responsePromise;
      expect(result).toBe('Review text');
    });

    it('rejects with RouterTimeoutError on timeout', async () => {
      vi.useFakeTimers();
      relay.start();

      const responsePromise = relay.sendPrompt('review_request', 'task-1', 'Review this', 5);

      vi.advanceTimersByTime(5001);

      await expect(responsePromise).rejects.toThrow(RouterTimeoutError);
      await expect(responsePromise).rejects.toThrow('Response timeout (5s)');
      expect(relay.pendingCount).toBe(0);

      vi.useRealTimers();
    });

    it('rejects if another prompt is already pending', async () => {
      relay.start();

      relay.sendPrompt('review_request', 'task-1', 'Review 1', 300);

      await expect(relay.sendPrompt('review_request', 'task-2', 'Review 2', 300)).rejects.toThrow(
        'Another prompt is already pending',
      );

      // Clean up first prompt
      stdin.write('done\n');
      stdin.write(END_OF_RESPONSE + '\n');
    });
  });

  describe('stdin handling', () => {
    it('accumulates lines until END_OF_RESPONSE', async () => {
      relay.start();

      const responsePromise = relay.sendPrompt('review_request', 'task-1', 'prompt', 300);

      stdin.write('line 1\n');
      stdin.write('line 2\n');
      stdin.write('line 3\n');
      stdin.write(END_OF_RESPONSE + '\n');

      const result = await responsePromise;
      expect(result).toBe('line 1\nline 2\nline 3');
    });

    it('does not truncate when delimiter appears as substring in content', async () => {
      relay.start();

      const responsePromise = relay.sendPrompt('review_request', 'task-1', 'prompt', 300);

      stdin.write('The marker <<<OPENCARA_END_RESPONSE>>> should not trigger mid-line\n');
      stdin.write('More content\n');
      stdin.write(END_OF_RESPONSE + '\n');

      const result = await responsePromise;
      expect(result).toContain('<<<OPENCARA_END_RESPONSE>>> should not trigger mid-line');
      expect(result).toContain('More content');
    });

    it('ignores lines when no prompt is pending', () => {
      relay.start();

      // Write without a pending prompt — should not throw
      stdin.write('orphan line\n');
      stdin.write(END_OF_RESPONSE + '\n');

      expect(relay.pendingCount).toBe(0);
    });

    it('rejects pending task with empty response on EOF', async () => {
      relay.start();

      const responsePromise = relay.sendPrompt('review_request', 'task-1', 'prompt', 300);

      stdin.end();

      await expect(responsePromise).rejects.toThrow('stdin closed with no response');
    });
  });

  describe('stop', () => {
    it('rejects pending task on stop', async () => {
      relay.start();

      const p1 = relay.sendPrompt('review_request', 'task-1', 'prompt', 300);

      relay.stop();

      await expect(p1).rejects.toThrow('Router relay stopped');
      expect(relay.pendingCount).toBe(0);
    });
  });

  describe('parseReviewResponse', () => {
    it('extracts verdict from response text', () => {
      const result = relay.parseReviewResponse(
        '## Summary\nLGTM\n\n## Findings\nNo issues found.\n\n## Verdict\nAPPROVE',
      );
      expect(result.verdict).toBe('approve');
      expect(result.review).toContain('LGTM');
      expect(result.review).not.toContain('Verdict');
    });

    it('defaults to comment when no verdict found', () => {
      const result = relay.parseReviewResponse('Some review text without verdict');
      expect(result.verdict).toBe('comment');
      expect(result.review).toBe('Some review text without verdict');
    });

    it('handles REQUEST_CHANGES verdict', () => {
      const result = relay.parseReviewResponse(
        '## Summary\nNeeds work\n\n## Verdict\nREQUEST_CHANGES',
      );
      expect(result.verdict).toBe('request_changes');
    });
  });

  describe('buildReviewPrompt', () => {
    it('builds a review prompt with system and user messages', () => {
      const prompt = relay.buildReviewPrompt({
        owner: 'acme',
        repo: 'widgets',
        reviewMode: 'full',
        prompt: 'Review carefully',
        diffContent: '+ added line',
      });

      expect(prompt).toContain('acme/widgets');
      expect(prompt).toContain('Review carefully');
      expect(prompt).toContain('+ added line');
      expect(prompt).toContain('## Verdict');
    });

    it('supports compact review mode', () => {
      const prompt = relay.buildReviewPrompt({
        owner: 'acme',
        repo: 'widgets',
        reviewMode: 'compact',
        prompt: 'Quick review',
        diffContent: 'diff',
      });

      expect(prompt).toContain('compact');
    });
  });

  describe('buildSummaryPrompt', () => {
    it('builds a summary prompt with reviews', () => {
      const prompt = relay.buildSummaryPrompt({
        owner: 'acme',
        repo: 'widgets',
        prompt: 'Review guidelines',
        reviews: [
          {
            agentId: 'a1',
            model: 'claude',
            tool: 'claude-code',
            review: 'LGTM',
            verdict: 'approve',
          },
        ],
        diffContent: 'some diff',
      });

      expect(prompt).toContain('acme/widgets');
      expect(prompt).toContain('1 review');
      expect(prompt).toContain('LGTM');
      expect(prompt).toContain('some diff');
    });
  });
});

describe('RouterTimeoutError', () => {
  it('has correct name and message', () => {
    const err = new RouterTimeoutError('timeout');
    expect(err.name).toBe('RouterTimeoutError');
    expect(err.message).toBe('timeout');
    expect(err).toBeInstanceOf(Error);
  });
});
