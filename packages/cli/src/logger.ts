import * as fs from 'node:fs';
import * as path from 'node:path';
import pc from 'picocolors';
import { sanitizeTokens } from './sanitize.js';

/** Status icons used in log output. */
export const icons = {
  start: pc.green('●'),
  polling: pc.cyan('↻'),
  success: pc.green('✓'),
  running: pc.blue('▶'),
  stop: pc.red('■'),
  warn: pc.yellow('⚠'),
  error: pc.red('✗'),
} as const;

/** Format current time as HH:MM:SS. */
export function timestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Strip ANSI escape codes from a string for plain-text file output. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '');
}

/** Logger functions that prepend a timestamp and optional label. */
export interface Logger {
  log: (msg: string) => void;
  logError: (msg: string) => void;
  logWarn: (msg: string) => void;
}

export interface LoggerOptions {
  label?: string;
  logFile?: string;
}

/**
 * Verify a log file path is writable. Creates parent directories if needed.
 * Returns true on success, false otherwise (with a warning printed to stderr).
 */
function verifyLogFile(filePath: string): boolean {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePath, '');
    return true;
  } catch (err) {
    console.warn(
      `Warning: Cannot open log file "${filePath}": ${(err as Error).message}. Continuing with console-only logging.`,
    );
    return false;
  }
}

export function createLogger(labelOrOptions?: string | LoggerOptions): Logger {
  const opts =
    typeof labelOrOptions === 'string' ? { label: labelOrOptions } : (labelOrOptions ?? {});
  const { label, logFile } = opts;

  const labelStr = label ? ` ${pc.dim(`[${label}]`)}` : '';

  const logFileOk = logFile ? verifyLogFile(logFile) : false;

  function writeToFile(line: string): void {
    if (!logFileOk || !logFile) return;
    try {
      fs.appendFileSync(logFile, stripAnsi(line) + '\n');
    } catch {
      // If writing fails mid-session, silently skip — console output continues
    }
  }

  return {
    log: (msg: string) => {
      const line = `${pc.dim(`[${timestamp()}]`)}${labelStr} ${sanitizeTokens(msg)}`;
      console.log(line);
      writeToFile(line);
    },
    logError: (msg: string) => {
      const line = `${pc.dim(`[${timestamp()}]`)}${labelStr} ${pc.red(sanitizeTokens(msg))}`;
      console.error(line);
      writeToFile(line);
    },
    logWarn: (msg: string) => {
      const line = `${pc.dim(`[${timestamp()}]`)}${labelStr} ${pc.yellow(sanitizeTokens(msg))}`;
      console.warn(line);
      writeToFile(line);
    },
  };
}

/** Session statistics for exit summary. */
export interface AgentSessionStats {
  startTime: number;
  tasksCompleted: number;
  errorsEncountered: number;
}

export function createAgentSession(): AgentSessionStats {
  return {
    startTime: Date.now(),
    tasksCompleted: 0,
    errorsEncountered: 0,
  };
}

/** Format elapsed time as human-readable string (e.g. "2h3m15s", "45s"). */
export function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

/** Format exit summary line. */
export function formatExitSummary(stats: AgentSessionStats): string {
  const uptime = formatUptime(Date.now() - stats.startTime);
  const tasks = stats.tasksCompleted === 1 ? '1 task' : `${stats.tasksCompleted} tasks`;
  const errors = stats.errorsEncountered === 1 ? '1 error' : `${stats.errorsEncountered} errors`;
  return `${icons.stop} Shutting down — ${tasks} completed, ${errors}, uptime ${uptime}`;
}
