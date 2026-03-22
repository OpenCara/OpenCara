/** Log level for structured JSON logging. */
export type LogLevel = 'info' | 'warn' | 'error';

/** A structured log entry emitted as JSON to console. */
export interface LogEntry {
  level: LogLevel;
  msg: string;
  ts: string;
  requestId?: string;
  [key: string]: unknown;
}

/**
 * Lightweight structured JSON logger for Cloudflare Workers.
 *
 * Outputs one JSON line per log call with a consistent shape.
 * Optional requestId is included in every entry when set.
 */
export class Logger {
  constructor(private readonly requestId?: string) {}

  info(msg: string, data?: Record<string, unknown>): void {
    this.emit('info', msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.emit('warn', msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.emit('error', msg, data);
  }

  private emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      level,
      msg,
      ts: new Date().toISOString(),
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...data,
    };

    switch (level) {
      case 'error':
        console.error(JSON.stringify(entry));
        break;
      case 'warn':
        console.warn(JSON.stringify(entry));
        break;
      default:
        console.log(JSON.stringify(entry));
    }
  }
}

/**
 * Create a logger without a request ID, for use outside of HTTP request
 * context (e.g., scheduled events, store internals).
 */
export function createLogger(): Logger {
  return new Logger();
}
