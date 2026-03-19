import * as readline from 'node:readline';
import { extractVerdict } from './review.js';
import { buildSystemPrompt, buildUserMessage, type ReviewRequest } from './review.js';
import {
  buildSummarySystemPrompt,
  buildSummaryUserMessage,
  type SummaryReviewInput,
} from './summary.js';

/** Output message types written to stdout as JSONL */
export type RouterOutputMessage =
  | { type: 'review_request'; taskId: string; prompt: string; timeout: number }
  | { type: 'summary_request'; taskId: string; prompt: string; timeout: number }
  | { type: 'idle'; message: string }
  | { type: 'shutdown'; reason: string }
  | { type: 'error'; taskId: string; message: string }
  | { type: 'timeout'; taskId: string; message: string };

/** Input message type read from stdin as JSONL */
export interface RouterInputMessage {
  taskId: string;
  response: string;
}

export interface PendingTask {
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RouterRelayDeps {
  stdin?: NodeJS.ReadableStream;
  stdout?: { write: (data: string) => void };
}

export class RouterRelay {
  private pending = new Map<string, PendingTask>();
  private rl: readline.Interface | null = null;
  private stdout: { write: (data: string) => void };
  private stdin: NodeJS.ReadableStream;
  private stopped = false;

  constructor(deps?: RouterRelayDeps) {
    this.stdin = deps?.stdin ?? process.stdin;
    this.stdout = deps?.stdout ?? process.stdout;
  }

  /** Start listening for stdin input */
  start(): void {
    this.stopped = false;
    this.rl = readline.createInterface({
      input: this.stdin,
      terminal: false,
    });

    this.rl.on('line', (line: string) => {
      this.handleLine(line);
    });

    this.rl.on('close', () => {
      // Only handle stdin-initiated close, not stop()-initiated close
      if (this.stopped) return;
      for (const [taskId, task] of this.pending) {
        clearTimeout(task.timer);
        task.reject(new Error('stdin closed'));
        this.pending.delete(taskId);
      }
    });
  }

  /** Stop listening and clean up */
  stop(): void {
    this.stopped = true;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    for (const [taskId, task] of this.pending) {
      clearTimeout(task.timer);
      task.reject(new Error('Router relay stopped'));
      this.pending.delete(taskId);
    }
  }

  /** Write a JSONL message to stdout */
  writeMessage(msg: RouterOutputMessage): void {
    this.stdout.write(JSON.stringify(msg) + '\n');
  }

  /** Build the full prompt for a review request */
  buildReviewPrompt(req: {
    owner: string;
    repo: string;
    reviewMode: string;
    prompt: string;
    diffContent: string;
  }): string {
    const systemPrompt = buildSystemPrompt(
      req.owner,
      req.repo,
      req.reviewMode as ReviewRequest['reviewMode'],
    );
    const userMessage = buildUserMessage(req.prompt, req.diffContent);
    return `${systemPrompt}\n\n${userMessage}`;
  }

  /** Build the full prompt for a summary request */
  buildSummaryPrompt(req: {
    owner: string;
    repo: string;
    prompt: string;
    reviews: SummaryReviewInput[];
    diffContent: string;
  }): string {
    const systemPrompt = buildSummarySystemPrompt(req.owner, req.repo, req.reviews.length);
    const userMessage = buildSummaryUserMessage(req.prompt, req.reviews, req.diffContent);
    return `${systemPrompt}\n\n${userMessage}`;
  }

  /**
   * Send a review/summary prompt to the external agent via stdout
   * and wait for the response via stdin.
   * Returns the raw response text.
   */
  sendPrompt(
    type: 'review_request' | 'summary_request',
    taskId: string,
    prompt: string,
    timeoutSec: number,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeoutMs = timeoutSec * 1000;

      const timer = setTimeout(() => {
        this.pending.delete(taskId);
        this.writeMessage({
          type: 'timeout',
          taskId,
          message: `Response timeout (${timeoutSec}s)`,
        });
        reject(new RouterTimeoutError(`Response timeout (${timeoutSec}s)`));
      }, timeoutMs);

      this.pending.set(taskId, { resolve, reject, timer });

      this.writeMessage({ type, taskId, prompt, timeout: timeoutSec });
    });
  }

  /** Parse a review response: extract verdict and review text */
  parseReviewResponse(response: string): { review: string; verdict: string } {
    return extractVerdict(response);
  }

  /** Get pending task count (for testing) */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Handle a single line from stdin */
  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Can't identify taskId from malformed JSON
      return;
    }

    if (!parsed || typeof parsed !== 'object') return;

    const msg = parsed as Record<string, unknown>;
    const taskId = msg.taskId;
    const response = msg.response;

    if (typeof taskId !== 'string' || typeof response !== 'string') {
      // Missing required fields — can't route without taskId
      if (typeof taskId === 'string') {
        this.writeMessage({
          type: 'error',
          taskId,
          message: 'Invalid response format: missing "response" field',
        });
      }
      return;
    }

    const pending = this.pending.get(taskId);
    if (!pending) {
      this.writeMessage({
        type: 'error',
        taskId,
        message: `No pending task with id "${taskId}"`,
      });
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(taskId);
    pending.resolve(response);
  }
}

export class RouterTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouterTimeoutError';
  }
}
