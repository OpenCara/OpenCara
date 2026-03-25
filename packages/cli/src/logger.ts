import pc from 'picocolors';
import { sanitizeTokens } from './sanitize.js';

/** Status icons used in log output. */
export const icons = {
  start: pc.green('●'),
  polling: pc.cyan('↻'),
  success: pc.green('✓'),
  running: pc.blue('▶'),
  stop: pc.red('■'),
  info: pc.blue('ℹ'),
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

/** Logger functions that prepend a timestamp and optional label. */
export interface Logger {
  log: (msg: string) => void;
  logError: (msg: string) => void;
  logWarn: (msg: string) => void;
}

export function createLogger(label?: string): Logger {
  const labelStr = label ? ` ${pc.dim(`[${label}]`)}` : '';
  return {
    log: (msg: string) =>
      console.log(`${pc.dim(`[${timestamp()}]`)}${labelStr} ${sanitizeTokens(msg)}`),
    logError: (msg: string) =>
      console.error(`${pc.dim(`[${timestamp()}]`)}${labelStr} ${pc.red(sanitizeTokens(msg))}`),
    logWarn: (msg: string) =>
      console.warn(`${pc.dim(`[${timestamp()}]`)}${labelStr} ${pc.yellow(sanitizeTokens(msg))}`),
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
