import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ToolExecutorResult {
  stdout: string;
  stderr: string;
  tokensUsed: number;
  /** True if tokensUsed was parsed from tool output (includes input+output).
   *  False if estimated from output text only (callers should add input estimate). */
  tokensParsed: boolean;
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

/** Maximum stderr length included in error/warning messages */
const MAX_STDERR_LENGTH = 1000;

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
      'Set command in ~/.opencara/config.yml agents section or run `opencara agent create`.',
  );
}

const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count from text length (~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function parseClaudeTokens(text: string): number | null {
  const inputMatch = text.match(/"input_tokens"\s*:\s*(\d+)/);
  const outputMatch = text.match(/"output_tokens"\s*:\s*(\d+)/);
  if (inputMatch && outputMatch) {
    return parseInt(inputMatch[1], 10) + parseInt(outputMatch[1], 10);
  }
  return null;
}

/**
 * Parse token usage from tool output. Tries tool-specific patterns first,
 * then falls back to character-based estimation.
 */
export function parseTokenUsage(
  stdout: string,
  stderr: string,
): { tokens: number; parsed: boolean } {
  // Codex: "tokens used 1,801" or "tokens used\n1,801" in stdout footer
  const codexMatch = stdout.match(/tokens\s+used[\s:]*([0-9,]+)/i);
  if (codexMatch) return { tokens: parseInt(codexMatch[1].replace(/,/g, ''), 10), parsed: true };

  // Claude JSON: "input_tokens" and "output_tokens" (order-independent)
  const claudeTotal = parseClaudeTokens(stdout) ?? parseClaudeTokens(stderr);
  if (claudeTotal !== null) return { tokens: claudeTotal, parsed: true };

  // Qwen JSON stats: "tokens": {"total": N}
  const qwenMatch = stdout.match(/"tokens"\s*:\s*\{[^}]*"total"\s*:\s*(\d+)/);
  if (qwenMatch) return { tokens: parseInt(qwenMatch[1], 10), parsed: true };

  // Fallback: estimate from output text length
  return { tokens: estimateTokens(stdout), parsed: false };
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

    function scheduleKillEscalation(): void {
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

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
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
      if (sigkillTimer) clearTimeout(sigkillTimer);
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
        reject(
          new ToolTimeoutError(
            `Tool "${command}" timed out after ${Math.round(timeoutMs / 1000)}s`,
          ),
        );
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
          resolve({ stdout, stderr, tokensUsed: usage.tokens, tokensParsed: usage.parsed });
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
      resolve({ stdout, stderr, tokensUsed: usage.tokens, tokensParsed: usage.parsed });
    });
  });
}

const TEST_COMMAND_PROMPT = 'Respond with: OK';
const TEST_COMMAND_TIMEOUT_MS = 10_000;

export interface TestCommandResult {
  ok: boolean;
  elapsedMs: number;
  error?: string;
}

/**
 * Dry-run a command template with a tiny test prompt to verify it works.
 * Returns success/failure + elapsed time. Never throws.
 */
export async function testCommand(commandTemplate: string): Promise<TestCommandResult> {
  const start = Date.now();
  try {
    await executeTool(commandTemplate, TEST_COMMAND_PROMPT, TEST_COMMAND_TIMEOUT_MS);
    return { ok: true, elapsedMs: Date.now() - start };
  } catch (err) {
    const elapsed = Date.now() - start;
    if (err instanceof ToolTimeoutError) {
      return {
        ok: false,
        elapsedMs: elapsed,
        error: `command timed out after ${TEST_COMMAND_TIMEOUT_MS / 1000}s`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, elapsedMs: elapsed, error: msg };
  }
}
