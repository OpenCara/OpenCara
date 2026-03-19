import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { RouterRelay, RouterTimeoutError } from '../router.js';

function createTestRelay(): {
  relay: RouterRelay;
  stdin: PassThrough;
  stdout: PassThrough;
  getOutput: () => string[];
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: string[] = [];

  stdout.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    chunks.push(...lines);
  });

  const relay = new RouterRelay({ stdin, stdout });
  return {
    relay,
    stdin,
    stdout,
    getOutput: () => chunks,
  };
}

describe('RouterRelay', () => {
  let relay: RouterRelay;
  let stdin: PassThrough;
  let stdout: PassThrough;
  let getOutput: () => string[];

  beforeEach(() => {
    ({ relay, stdin, stdout, getOutput } = createTestRelay());
  });

  afterEach(() => {
    relay.stop();
    stdin.destroy();
    stdout.destroy();
  });

  describe('writeMessage', () => {
    it('writes JSONL to stdout', () => {
      relay.writeMessage({ type: 'idle', message: 'Waiting for review requests...' });

      const lines = getOutput();
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.type).toBe('idle');
      expect(parsed.message).toBe('Waiting for review requests...');
    });

    it('writes multiple messages as separate lines', () => {
      relay.writeMessage({ type: 'idle', message: 'Waiting...' });
      relay.writeMessage({ type: 'shutdown', reason: 'idle_timeout' });

      const lines = getOutput();
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).type).toBe('idle');
      expect(JSON.parse(lines[1]).type).toBe('shutdown');
    });
  });

  describe('sendPrompt', () => {
    it('writes prompt to stdout and resolves on stdin response', async () => {
      relay.start();

      const responsePromise = relay.sendPrompt('review_request', 'task-1', 'Review this code', 300);

      // Check prompt was written to stdout
      const lines = getOutput();
      expect(lines).toHaveLength(1);
      const prompt = JSON.parse(lines[0]);
      expect(prompt.type).toBe('review_request');
      expect(prompt.taskId).toBe('task-1');
      expect(prompt.prompt).toBe('Review this code');
      expect(prompt.timeout).toBe(300);

      // Send response via stdin
      stdin.write(
        JSON.stringify({ taskId: 'task-1', response: 'LGTM\n\n## Verdict\nAPPROVE' }) + '\n',
      );

      const result = await responsePromise;
      expect(result).toBe('LGTM\n\n## Verdict\nAPPROVE');
      expect(relay.pendingCount).toBe(0);
    });

    it('writes summary_request prompt to stdout', async () => {
      relay.start();

      const responsePromise = relay.sendPrompt(
        'summary_request',
        'task-2',
        'Summarize reviews',
        300,
      );

      const lines = getOutput();
      const prompt = JSON.parse(lines[0]);
      expect(prompt.type).toBe('summary_request');
      expect(prompt.taskId).toBe('task-2');

      stdin.write(JSON.stringify({ taskId: 'task-2', response: 'Summary text' }) + '\n');
      const result = await responsePromise;
      expect(result).toBe('Summary text');
    });

    it('rejects with RouterTimeoutError on timeout', async () => {
      vi.useFakeTimers();
      relay.start();

      const responsePromise = relay.sendPrompt('review_request', 'task-1', 'Review this', 5);

      // Advance past timeout
      vi.advanceTimersByTime(5001);

      await expect(responsePromise).rejects.toThrow(RouterTimeoutError);
      await expect(responsePromise).rejects.toThrow('Response timeout (5s)');

      // Check timeout message was written to stdout
      const lines = getOutput();
      const timeoutMsg = JSON.parse(lines[lines.length - 1]);
      expect(timeoutMsg.type).toBe('timeout');
      expect(timeoutMsg.taskId).toBe('task-1');

      expect(relay.pendingCount).toBe(0);

      vi.useRealTimers();
    });

    it('handles multiple concurrent prompts', async () => {
      relay.start();

      const p1 = relay.sendPrompt('review_request', 'task-1', 'Review 1', 300);
      const p2 = relay.sendPrompt('summary_request', 'task-2', 'Summary', 300);

      expect(relay.pendingCount).toBe(2);

      // Respond out of order
      stdin.write(JSON.stringify({ taskId: 'task-2', response: 'Summary result' }) + '\n');
      stdin.write(JSON.stringify({ taskId: 'task-1', response: 'Review result' }) + '\n');

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe('Review result');
      expect(r2).toBe('Summary result');
      expect(relay.pendingCount).toBe(0);
    });
  });

  describe('stdin handling', () => {
    it('ignores empty lines', async () => {
      relay.start();

      const responsePromise = relay.sendPrompt('review_request', 'task-1', 'prompt', 300);

      stdin.write('\n');
      stdin.write('   \n');
      stdin.write(JSON.stringify({ taskId: 'task-1', response: 'done' }) + '\n');

      const result = await responsePromise;
      expect(result).toBe('done');
    });

    it('ignores malformed JSON', async () => {
      relay.start();

      const responsePromise = relay.sendPrompt('review_request', 'task-1', 'prompt', 300);

      stdin.write('not json\n');
      stdin.write(JSON.stringify({ taskId: 'task-1', response: 'done' }) + '\n');

      const result = await responsePromise;
      expect(result).toBe('done');
    });

    it('writes error for missing response field', async () => {
      relay.start();

      const responsePromise = relay.sendPrompt('review_request', 'task-1', 'prompt', 300);

      // Send with taskId but no response field
      stdin.write(JSON.stringify({ taskId: 'task-1' }) + '\n');

      // Check error was written
      const lines = getOutput();
      const errorMsg = JSON.parse(lines[lines.length - 1]);
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.taskId).toBe('task-1');
      expect(errorMsg.message).toContain('missing "response" field');

      // Task should still be pending
      expect(relay.pendingCount).toBe(1);

      // Send valid response to clean up
      stdin.write(JSON.stringify({ taskId: 'task-1', response: 'done' }) + '\n');
      await responsePromise;
    });

    it('writes error for unknown taskId', () => {
      relay.start();

      stdin.write(JSON.stringify({ taskId: 'unknown-task', response: 'result' }) + '\n');

      // Give it a tick to process
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const lines = getOutput();
          const errorMsg = JSON.parse(lines[lines.length - 1]);
          expect(errorMsg.type).toBe('error');
          expect(errorMsg.taskId).toBe('unknown-task');
          expect(errorMsg.message).toContain('No pending task');
          resolve();
        }, 10);
      });
    });

    it('rejects all pending tasks when stdin closes', async () => {
      relay.start();

      const p1 = relay.sendPrompt('review_request', 'task-1', 'prompt', 300);
      const p2 = relay.sendPrompt('review_request', 'task-2', 'prompt', 300);

      stdin.end();

      await expect(p1).rejects.toThrow('stdin closed');
      await expect(p2).rejects.toThrow('stdin closed');
      expect(relay.pendingCount).toBe(0);
    });
  });

  describe('stop', () => {
    it('rejects all pending tasks on stop', async () => {
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
