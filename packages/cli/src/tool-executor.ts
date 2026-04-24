import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TokenUsageDetail {
  input: number;
  output: number;
  total: number;
  parsed: boolean;
}

export interface ToolExecutorResult {
  stdout: string;
  stderr: string;
  tokensUsed: number;
  /** True if tokensUsed was parsed from tool output (includes input+output).
   *  False if estimated from output text only (callers should add input estimate). */
  tokensParsed: boolean;
  /** Detailed token breakdown when available. */
  tokenDetail: TokenUsageDetail;
}

export class ToolTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolTimeoutError';
  }
}

/** Grace period (ms) before escalating SIGTERM to SIGKILL */
export const SIGKILL_GRACE_MS = 5_000;

/** Minimum stdout length to treat a non-zero exit as a partial success */
const MIN_PARTIAL_RESULT_LENGTH = 50;

/** Default stdout liveness timeout (ms). Kill process if no stdout for this long. */
export const STDOUT_LIVENESS_TIMEOUT_MS = 300_000;

/** Default heartbeat interval (ms) when a heartbeat callback is supplied. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

/** Maximum stderr length included in error/warning messages */
const MAX_STDERR_LENGTH = 1000;

/**
 * Heartbeat control — fires `callback` every `intervalMs` while the tool is
 * running. The callback MUST not throw; any error it produces is caught by
 * the caller and swallowed. The interval is cleared when the tool exits
 * (success, error, timeout, kill, abort).
 */
export interface HeartbeatControl {
  callback: () => void | Promise<void>;
  /** Defaults to {@link DEFAULT_HEARTBEAT_INTERVAL_MS} when omitted. */
  intervalMs?: number;
}

/**
 * Start a heartbeat `setInterval` that fires `heartbeat.callback` every
 * `intervalMs` (default {@link DEFAULT_HEARTBEAT_INTERVAL_MS}). Returns a
 * stop function that clears the interval — callers MUST invoke it on every
 * exit path (close, error, timeout, kill, abort) to prevent leaks.
 *
 * `isSettled` is an optional predicate consulted on each tick: when it
 * returns true, the callback is skipped. This lets the caller guard against
 * one last tick firing between SIGTERM and the close event.
 *
 * Callback errors (sync throws and async rejections) are swallowed — a
 * broken heartbeat must NEVER kill the in-flight tool.
 *
 * Returns a no-op stopper when `heartbeat` is undefined or `intervalMs` is 0.
 */
export function startHeartbeatTimer(
  heartbeat: HeartbeatControl | undefined,
  isSettled: () => boolean = () => false,
): () => void {
  if (!heartbeat) return () => {};
  const intervalMs = heartbeat.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (intervalMs <= 0) return () => {};

  const timer = setInterval(() => {
    if (isSettled()) return;
    try {
      const r = heartbeat.callback();
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => {
          /* swallowed — heartbeat must not kill the tool */
        });
      }
    } catch {
      /* swallowed — heartbeat must not kill the tool */
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

/**
 * Validate that the binary referenced by a command template exists and is executable.
 * Cross-platform: uses `where` on Windows, `command -v` via shell on Unix.
 */
export function validateCommandBinary(commandTemplate: string): boolean {
  const { command } = parseCommandTemplate(commandTemplate);

  if (path.isAbsolute(command)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  try {
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      execFileSync('where', [command], { stdio: 'pipe' });
    } else {
      // Pass command as positional arg to avoid shell injection
      execFileSync('sh', ['-c', 'command -v -- "$1"', '_', command], { stdio: 'pipe' });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a command template string into command + args.
 * Splits on whitespace first, then interpolates ${VAR} variables.
 * This ensures variables containing spaces/special chars stay as single args.
 */
export function parseCommandTemplate(
  template: string,
  vars: Record<string, string> = {},
): { command: string; args: string[] } {
  // Split on whitespace first, respecting quoted strings
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    parts.push(current);
  }

  // Interpolate variables after splitting — each ${VAR} stays as one arg
  const interpolated = parts.map((part) => {
    let result = part;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replaceAll(`\${${key}}`, value);
    }
    return result;
  });

  if (interpolated.length === 0) {
    throw new Error('Empty command template');
  }

  return { command: interpolated[0], args: interpolated.slice(1) };
}

/**
 * Resolve a command template from explicit config.
 * Returns the template string or throws if not available.
 */
export function resolveCommandTemplate(agentCommand: string | null | undefined): string {
  if (agentCommand) {
    return agentCommand;
  }
  throw new Error(
    'No command configured for this agent. ' +
      'Set command in ~/.opencara/config.toml agents section or run `opencara agent create`.',
  );
}

const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count from text length (~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function parseClaudeTokens(text: string): { input: number; output: number } | null {
  const inputMatch = text.match(/"input_tokens"\s*:\s*(\d+)/);
  const outputMatch = text.match(/"output_tokens"\s*:\s*(\d+)/);
  if (inputMatch && outputMatch) {
    return {
      input: parseInt(inputMatch[1], 10),
      output: parseInt(outputMatch[1], 10),
    };
  }
  return null;
}

export interface ParsedTokenUsage {
  tokens: number;
  parsed: boolean;
  input: number;
  output: number;
}

/**
 * Parse token usage from tool output. Tries tool-specific patterns first,
 * then falls back to character-based estimation.
 */
export function parseTokenUsage(stdout: string, stderr: string): ParsedTokenUsage {
  // Codex: "tokens used 1,801" or "tokens used\n1,801" in stdout footer
  const codexMatch = stdout.match(/tokens\s+used[\s:]*([0-9,]+)/i);
  if (codexMatch) {
    const total = parseInt(codexMatch[1].replace(/,/g, ''), 10);
    return { tokens: total, parsed: true, input: 0, output: total };
  }

  // Claude JSON: "input_tokens" and "output_tokens" (order-independent)
  const claudeResult = parseClaudeTokens(stdout) ?? parseClaudeTokens(stderr);
  if (claudeResult !== null) {
    return {
      tokens: claudeResult.input + claudeResult.output,
      parsed: true,
      input: claudeResult.input,
      output: claudeResult.output,
    };
  }

  // Qwen JSON stats: "tokens": {"total": N}
  const qwenMatch = stdout.match(/"tokens"\s*:\s*\{[^}]*"total"\s*:\s*(\d+)/);
  if (qwenMatch) {
    const total = parseInt(qwenMatch[1], 10);
    return { tokens: total, parsed: true, input: 0, output: total };
  }

  // Fallback: estimate from output text length
  const estimated = estimateTokens(stdout);
  return { tokens: estimated, parsed: false, input: 0, output: estimated };
}

/**
 * Execute a tool command with prompt.
 *
 * If the command template contains `${PROMPT}`, the prompt is interpolated
 * as a CLI argument. Otherwise, the prompt is delivered via stdin.
 */
export function executeTool(
  commandTemplate: string,
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
  vars?: Record<string, string>,
  cwd?: string,
  livenessTimeoutMs?: number,
  heartbeat?: HeartbeatControl,
): Promise<ToolExecutorResult> {
  const promptViaArg = commandTemplate.includes('${PROMPT}');
  const allVars: Record<string, string> = { ...vars, PROMPT: prompt };
  // Backward compatibility: populate CODEBASE_DIR so existing command templates
  // that use ${CODEBASE_DIR} (e.g. --cwd '${CODEBASE_DIR}') continue to work
  if (cwd && !allVars['CODEBASE_DIR']) {
    allVars['CODEBASE_DIR'] = cwd;
  }
  const { command, args } = parseCommandTemplate(commandTemplate, allVars);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ToolTimeoutError('Tool execution aborted'));
      return;
    }

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    let killedByLiveness = false;

    // Resolve effective liveness timeout: undefined → default, 0 → disabled
    const effectiveLivenessMs =
      livenessTimeoutMs === undefined ? STDOUT_LIVENESS_TIMEOUT_MS : livenessTimeoutMs;

    let killScheduled = false;

    function scheduleKillEscalation(): void {
      if (killScheduled) return;
      killScheduled = true;
      child.kill('SIGTERM');
      // Clear any existing SIGKILL timer to prevent leaks
      if (sigkillTimer) clearTimeout(sigkillTimer);
      // Escalate to SIGKILL after grace period if process hasn't exited
      sigkillTimer = setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, SIGKILL_GRACE_MS);
    }

    // Timeout handling via manual timer since spawn doesn't support timeout
    const timer = setTimeout(scheduleKillEscalation, timeoutMs);

    // Stdout liveness timer: kill if no stdout for effectiveLivenessMs
    let livenessTimer: ReturnType<typeof setTimeout> | undefined;
    if (effectiveLivenessMs > 0) {
      livenessTimer = setTimeout(() => {
        if (!settled) {
          killedByLiveness = true;
          scheduleKillEscalation();
        }
      }, effectiveLivenessMs);
    }

    // Heartbeat: fires callback every intervalMs while the tool is running.
    // The `isSettled` predicate suppresses the one last tick that may fire
    // between SIGTERM and the close event. See startHeartbeatTimer.
    const stopHeartbeat = startHeartbeatTimer(heartbeat, () => settled);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      // Reset liveness timer on stdout activity
      if (livenessTimer) {
        clearTimeout(livenessTimer);
        livenessTimer = setTimeout(() => {
          if (!settled) {
            killedByLiveness = true;
            scheduleKillEscalation();
          }
        }, effectiveLivenessMs);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Deliver prompt via stdin only if not already in args
    if (!promptViaArg) {
      child.stdin?.write(prompt);
    }
    child.stdin?.end();

    // Set up abort signal handler (stored for cleanup)
    let onAbort: (() => void) | undefined;
    if (signal) {
      onAbort = scheduleKillEscalation;
      signal.addEventListener('abort', onAbort, { once: true });
    }

    function cleanup(): void {
      clearTimeout(timer);
      if (livenessTimer) clearTimeout(livenessTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      stopHeartbeat();
      if (onAbort && signal) {
        signal.removeEventListener('abort', onAbort);
      }
    }

    child.on('error', (err) => {
      cleanup();
      if (settled) return;
      settled = true;
      if (signal?.aborted) {
        reject(new ToolTimeoutError('Tool execution aborted'));
        return;
      }
      reject(err);
    });

    child.on('close', (code, sig) => {
      cleanup();
      if (settled) return;
      settled = true;

      if (signal?.aborted) {
        reject(new ToolTimeoutError('Tool execution aborted'));
        return;
      }

      if (sig === 'SIGTERM' || sig === 'SIGKILL') {
        if (killedByLiveness) {
          reject(
            new ToolTimeoutError(
              `Tool "${command}" killed: no stdout for ${Math.round(effectiveLivenessMs / 1000)}s (process may be stuck)`,
            ),
          );
        } else {
          reject(
            new ToolTimeoutError(
              `Tool "${command}" timed out after ${Math.round(timeoutMs / 1000)}s`,
            ),
          );
        }
        return;
      }

      if (code !== 0) {
        // Non-zero exit but has meaningful output — treat as partial success
        if (stdout.length >= MIN_PARTIAL_RESULT_LENGTH) {
          console.warn(
            `Tool "${command}" exited with code ${code} but produced output. Treating as partial result.`,
          );
          if (stderr) {
            console.warn(`Tool stderr: ${stderr.slice(0, MAX_STDERR_LENGTH)}`);
          }
          const usage = parseTokenUsage(stdout, stderr);
          resolve({
            stdout,
            stderr,
            tokensUsed: usage.tokens,
            tokensParsed: usage.parsed,
            tokenDetail: {
              input: usage.input,
              output: usage.output,
              total: usage.tokens,
              parsed: usage.parsed,
            },
          });
          return;
        }

        // No meaningful output — actual failure
        const errMsg = stderr
          ? `Tool "${command}" failed (exit code ${code}): ${stderr.slice(0, MAX_STDERR_LENGTH)}`
          : `Tool "${command}" failed with exit code ${code}`;
        reject(new Error(errMsg));
        return;
      }

      const usage = parseTokenUsage(stdout, stderr);
      resolve({
        stdout,
        stderr,
        tokensUsed: usage.tokens,
        tokensParsed: usage.parsed,
        tokenDetail: {
          input: usage.input,
          output: usage.output,
          total: usage.tokens,
          parsed: usage.parsed,
        },
      });
    });
  });
}

const TEST_COMMAND_PROMPT = 'Respond with: OK';
const DEFAULT_TEST_COMMAND_TIMEOUT_MS = 10_000;

export interface TestCommandResult {
  ok: boolean;
  elapsedMs: number;
  error?: string;
}

/**
 * Dry-run a command template with a tiny test prompt to verify it works.
 * Returns success/failure + elapsed time. Never throws.
 * @param timeoutMs — override the default 10s timeout (e.g. from config.toml command_test_timeout)
 */
export async function testCommand(
  commandTemplate: string,
  timeoutMs: number = DEFAULT_TEST_COMMAND_TIMEOUT_MS,
): Promise<TestCommandResult> {
  const start = Date.now();
  try {
    await executeTool(commandTemplate, TEST_COMMAND_PROMPT, timeoutMs);
    return { ok: true, elapsedMs: Date.now() - start };
  } catch (err) {
    const elapsed = Date.now() - start;
    if (err instanceof ToolTimeoutError) {
      return {
        ok: false,
        elapsedMs: elapsed,
        error: `command timed out after ${timeoutMs / 1000}s`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, elapsedMs: elapsed, error: msg };
  }
}
