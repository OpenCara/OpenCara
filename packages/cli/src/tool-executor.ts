import { spawn } from 'node:child_process';

export interface ToolExecutorResult {
  stdout: string;
  stderr: string;
  tokensUsed: number;
}

export interface ToolCommand {
  buildCommand(): { command: string; args: string[] };
  parseTokenUsage?(stdout: string): number;
}

const TOOL_REGISTRY: Record<string, ToolCommand> = {
  'claude-code': {
    buildCommand() {
      return { command: 'claude', args: ['-p', '--output-format', 'json'] };
    },
    parseTokenUsage(stdout: string): number {
      try {
        const parsed = JSON.parse(stdout);
        if (parsed && typeof parsed.usage === 'object' && parsed.usage !== null) {
          const input =
            typeof parsed.usage.input_tokens === 'number' ? parsed.usage.input_tokens : 0;
          const output =
            typeof parsed.usage.output_tokens === 'number' ? parsed.usage.output_tokens : 0;
          return input + output;
        }
      } catch {
        // Not JSON or no usage field — return 0
      }
      return 0;
    },
  },
  codex: {
    buildCommand() {
      return { command: 'codex', args: ['exec'] };
    },
  },
  gemini: {
    buildCommand() {
      return { command: 'gemini', args: ['-p'] };
    },
  },
};

export function getSupportedTools(): string[] {
  return Object.keys(TOOL_REGISTRY);
}

export function getToolCommand(toolName: string): ToolCommand {
  const tool = TOOL_REGISTRY[toolName];
  if (!tool) {
    const supported = getSupportedTools().join(', ');
    throw new UnsupportedToolError(`Unknown tool "${toolName}". Supported tools: ${supported}`);
  }
  return tool;
}

export class UnsupportedToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedToolError';
  }
}

export class ToolTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolTimeoutError';
  }
}

/** Minimum stdout length to treat a non-zero exit as a partial success */
const MIN_PARTIAL_RESULT_LENGTH = 10;

/**
 * Extract the text result from claude-code JSON output.
 * Falls back to raw stdout if parsing fails.
 */
export function extractClaudeCodeResult(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed.result === 'string') {
      return parsed.result;
    }
  } catch {
    // Not valid JSON — return raw stdout
  }
  return stdout;
}

export function executeTool(
  toolName: string,
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ToolExecutorResult> {
  const tool = getToolCommand(toolName);
  const { command, args } = tool.buildCommand();

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

    child.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (signal?.aborted) {
        reject(new ToolTimeoutError('Tool execution aborted'));
        return;
      }
      reject(err);
    });

    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (signal?.aborted) {
        reject(new ToolTimeoutError('Tool execution aborted'));
        return;
      }

      if (sig === 'SIGTERM' || sig === 'SIGKILL') {
        reject(
          new ToolTimeoutError(
            `Tool "${toolName}" timed out after ${Math.round(timeoutMs / 1000)}s`,
          ),
        );
        return;
      }

      // For claude-code, extract text from JSON wrapper
      const outputText = toolName === 'claude-code' ? extractClaudeCodeResult(stdout) : stdout;

      if (code !== 0) {
        // Non-zero exit but has meaningful output — treat as partial success
        if (stdout.length >= MIN_PARTIAL_RESULT_LENGTH) {
          console.warn(
            `Tool "${toolName}" exited with code ${code} but produced output. Treating as partial result.`,
          );
          if (stderr) {
            console.warn(`Tool stderr: ${stderr.slice(0, 500)}`);
          }
          const tokensUsed = tool.parseTokenUsage ? tool.parseTokenUsage(stdout) : 0;
          resolve({ stdout: outputText, stderr, tokensUsed });
          return;
        }

        // No meaningful output — actual failure
        const errMsg = stderr
          ? `Tool "${toolName}" failed (exit code ${code}): ${stderr.slice(0, 1000)}`
          : `Tool "${toolName}" failed with exit code ${code}`;
        reject(new Error(errMsg));
        return;
      }

      const tokensUsed = tool.parseTokenUsage ? tool.parseTokenUsage(stdout) : 0;
      resolve({ stdout: outputText, stderr, tokensUsed });
    });

    if (signal) {
      const onAbort = () => {
        child.kill();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
