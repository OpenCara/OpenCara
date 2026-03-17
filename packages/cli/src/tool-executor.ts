import { spawn } from 'node:child_process';

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

/** Default command templates for known tools (backward compatibility) */
export const DEFAULT_COMMANDS: Record<string, string> = {
  'claude-code': 'claude -p --output-format text',
  codex: 'codex exec',
  gemini: 'gemini -p',
};

/** Minimum stdout length to treat a non-zero exit as a partial success */
const MIN_PARTIAL_RESULT_LENGTH = 50;

/** Maximum stderr length included in error/warning messages */
const MAX_STDERR_LENGTH = 1000;

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
 * Resolve a command template from explicit config or default fallback.
 * Returns the template string or throws if neither is available.
 */
export function resolveCommandTemplate(
  agentCommand: string | null,
  toolName: string | undefined,
): string {
  if (agentCommand) {
    return agentCommand;
  }
  if (toolName && toolName in DEFAULT_COMMANDS) {
    return DEFAULT_COMMANDS[toolName];
  }
  const supported = Object.keys(DEFAULT_COMMANDS).join(', ');
  throw new Error(
    `No agent_command configured and no default for tool "${toolName ?? 'unknown'}". ` +
      `Set agent_command in ~/.opencrust/config.yml or use a supported tool: ${supported}`,
  );
}

/**
 * Execute a tool command with prompt delivered via stdin.
 * The commandTemplate is a shell-style command string (e.g., "claude -p --output-format text").
 */
export function executeTool(
  commandTemplate: string,
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
  vars?: Record<string, string>,
): Promise<ToolExecutorResult> {
  const { command, args } = parseCommandTemplate(commandTemplate, vars);

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

    // Write prompt to stdin and close it
    child.stdin?.write(prompt);
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
