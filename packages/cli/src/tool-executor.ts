import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ToolExecutorResult {
  stdout: string;
  stderr: string;
  tokensUsed: number;
}

export class ToolTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolTimeoutError';
  }
}

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
 * Splits on whitespace, respecting double-quoted and single-quoted segments.
 * Interpolates ${VAR} variables from the provided vars map.
 */
export function parseCommandTemplate(
  template: string,
  vars: Record<string, string> = {},
): { command: string; args: string[] } {
  // Interpolate variables
  let interpolated = template;
  for (const [key, value] of Object.entries(vars)) {
    interpolated = interpolated.replaceAll(`\${${key}}`, value);
  }

  // Split on whitespace, respecting quoted strings
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < interpolated.length; i++) {
    const ch = interpolated[i];
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

  if (parts.length === 0) {
    throw new Error('Empty command template');
  }

  return { command: parts[0], args: parts.slice(1) };
}

/**
 * Resolve a command template from explicit config.
 * Returns the template string or throws if not available.
 */
export function resolveCommandTemplate(
  agentCommand: string | null | undefined,
  _toolName?: string,
): string {
  if (agentCommand) {
    return agentCommand;
  }
  throw new Error(
    'No command configured for this agent. ' +
      'Set command in ~/.opencrust/config.yml agents section or run `opencrust agent create`.',
  );
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
): Promise<ToolExecutorResult> {
  const promptViaArg = commandTemplate.includes('${PROMPT}');
  const allVars = { ...vars, PROMPT: prompt };
  const { command, args } = parseCommandTemplate(commandTemplate, allVars);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ToolTimeoutError('Tool execution aborted'));
      return;
    }

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    // Timeout handling via manual timer since spawn doesn't support timeout
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

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
      onAbort = () => {
        child.kill();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    function cleanup(): void {
      clearTimeout(timer);
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
          resolve({ stdout, stderr, tokensUsed: 0 });
          return;
        }

        // No meaningful output — actual failure
        const errMsg = stderr
          ? `Tool "${command}" failed (exit code ${code}): ${stderr.slice(0, MAX_STDERR_LENGTH)}`
          : `Tool "${command}" failed with exit code ${code}`;
        reject(new Error(errMsg));
        return;
      }

      resolve({ stdout, stderr, tokensUsed: 0 });
    });
  });
}
