import * as readline from 'node:readline';
import {
  extractVerdict,
  buildSystemPrompt,
  buildUserMessage,
  type ReviewRequest,
} from './review.js';
import {
  buildSummarySystemPrompt,
  buildSummaryUserMessage,
  type SummaryReviewInput,
} from './summary.js';

/**
 * End-of-response marker. The external agent writes this on its own line
 * to signal it has finished its response. If stdin reaches EOF, that also
 * terminates the current response.
 */
export const END_OF_RESPONSE = '<<<OPENCARA_END_RESPONSE>>>';

export interface PendingTask {
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RouterRelayDeps {
  stdin?: NodeJS.ReadableStream;
  stdout?: { write: (data: string) => void };
  stderr?: { write: (data: string) => void };
}

export class RouterRelay {
  private pending: PendingTask | null = null;
  private responseLines: string[] = [];
  private rl: readline.Interface | null = null;
  private stdout: { write: (data: string) => void };
  private stderr: { write: (data: string) => void };
  private stdin: NodeJS.ReadableStream;
  private stopped = false;

  constructor(deps?: RouterRelayDeps) {
    this.stdin = deps?.stdin ?? process.stdin;
    this.stdout = deps?.stdout ?? process.stdout;
    this.stderr = deps?.stderr ?? process.stderr;
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
      if (this.stopped) return;
      // EOF on stdin — router process likely died
      if (this.pending) {
        const response = this.responseLines.join('\n').trim();
        this.responseLines = [];
        clearTimeout(this.pending.timer);
        const task = this.pending;
        this.pending = null;

        // Only accept if we have substantial content (>=100 chars)
        if (response.length >= 100) {
          console.warn('Router stdin closed — accepting partial response');
          task.resolve(response);
        } else {
          task.reject(new Error('Router process died (stdin closed with insufficient response)'));
        }
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
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('Router relay stopped'));
      this.pending = null;
      this.responseLines = [];
    }
  }

  /** Write the prompt as plain text to stdout */
  writePrompt(prompt: string): void {
    try {
      this.stdout.write(prompt + '\n');
    } catch (err) {
      throw new Error(`Failed to write to router: ${(err as Error).message}`);
    }
  }

  /** Write a status message to stderr (doesn't interfere with prompt/response on stdout/stdin) */
  writeStatus(message: string): void {
    this.stderr.write(message + '\n');
  }

  /** Build the full prompt for a review request */
  buildReviewPrompt(req: {
    owner: string;
    repo: string;
    reviewMode: string;
    prompt: string;
    diffContent: string;
    contextBlock?: string;
  }): string {
    const systemPrompt = buildSystemPrompt(
      req.owner,
      req.repo,
      req.reviewMode as ReviewRequest['reviewMode'],
    );
    const userMessage = buildUserMessage(req.prompt, req.diffContent, req.contextBlock);
    return `${systemPrompt}\n\n${userMessage}`;
  }

  /** Build the full prompt for a summary request */
  buildSummaryPrompt(req: {
    owner: string;
    repo: string;
    prompt: string;
    reviews: SummaryReviewInput[];
    diffContent: string;
    contextBlock?: string;
  }): string {
    const systemPrompt = buildSummarySystemPrompt(req.owner, req.repo, req.reviews.length);
    const userMessage = buildSummaryUserMessage(
      req.prompt,
      req.reviews,
      req.diffContent,
      req.contextBlock,
    );
    return `${systemPrompt}\n\n${userMessage}`;
  }

  /**
   * Send a prompt to the external agent via stdout (plain text)
   * and wait for the response via stdin (plain text, terminated by END_OF_RESPONSE or EOF).
   */
  sendPrompt(
    _type: 'review_request' | 'summary_request',
    _taskId: string,
    prompt: string,
    timeoutSec: number,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.pending) {
        reject(new Error('Another prompt is already pending'));
        return;
      }

      const timeoutMs = timeoutSec * 1000;
      this.responseLines = [];

      const timer = setTimeout(() => {
        this.pending = null;
        this.responseLines = [];
        reject(new RouterTimeoutError(`Response timeout (${timeoutSec}s)`));
      }, timeoutMs);

      this.pending = { resolve, reject, timer };

      // Write prompt as plain text to stdout
      try {
        this.writePrompt(prompt);
      } catch (err) {
        clearTimeout(timer);
        this.pending = null;
        this.responseLines = [];
        reject(err as Error);
      }
    });
  }

  /** Parse a review response: extract verdict and review text */
  parseReviewResponse(response: string): { review: string; verdict: string } {
    return extractVerdict(response);
  }

  /** Get whether a task is pending (for testing) */
  get pendingCount(): number {
    return this.pending ? 1 : 0;
  }

  /** Handle a single line from stdin */
  private handleLine(line: string): void {
    if (!this.pending) return;

    // Check for end-of-response marker
    if (line.trim() === END_OF_RESPONSE) {
      const response = this.responseLines.join('\n').trim();
      this.responseLines = [];
      clearTimeout(this.pending.timer);
      const task = this.pending;
      this.pending = null;

      if (!response || response.length < 10) {
        task.reject(new Error('Router returned empty or trivially short response'));
        return;
      }

      task.resolve(response);
      return;
    }

    // Accumulate response lines
    this.responseLines.push(line);
  }
}

export class RouterTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouterTimeoutError';
  }
}
