import { execFile } from 'node:child_process';

export interface ToolExecutorResult {
  stdout: string;
  tokensUsed: number;
}

export interface ToolCommand {
  buildCommand(prompt: string): { command: string; args: string[] };
  parseTokenUsage?(stdout: string): number;
}

const TOOL_REGISTRY: Record<string, ToolCommand> = {
  'claude-code': {
    buildCommand(prompt: string) {
      return { command: 'claude', args: ['-p', prompt, '--output-format', 'text'] };
    },
  },
  codex: {
    buildCommand(prompt: string) {
      return { command: 'codex', args: ['exec', prompt] };
    },
  },
  gemini: {
    buildCommand(prompt: string) {
      return { command: 'gemini', args: ['-p', prompt] };
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

export function executeTool(
  toolName: string,
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ToolExecutorResult> {
  const tool = getToolCommand(toolName);
  const { command, args } = tool.buildCommand(prompt);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ToolTimeoutError('Tool execution aborted'));
      return;
    }

    const child = execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (signal?.aborted) {
          reject(new ToolTimeoutError('Tool execution aborted'));
          return;
        }
        if (error) {
          if ('killed' in error && error.killed) {
            reject(
              new ToolTimeoutError(
                `Tool "${toolName}" timed out after ${Math.round(timeoutMs / 1000)}s`,
              ),
            );
          } else {
            reject(error);
          }
          return;
        }

        const tokensUsed = tool.parseTokenUsage ? tool.parseTokenUsage(stdout) : 0;
        resolve({ stdout, tokensUsed });
      },
    );

    if (signal) {
      const onAbort = () => {
        child.kill();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
