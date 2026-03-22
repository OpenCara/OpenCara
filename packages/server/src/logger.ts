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
    // Spread user data first so core fields cannot be overwritten
    const entry: LogEntry = {
      ...data,
      level,
      msg,
      ts: new Date().toISOString(),
      ...(this.requestId ? { requestId: this.requestId } : {}),
    };

    let serialized: string;
    try {
      serialized = JSON.stringify(entry);
    } catch {
      // Fallback for circular references or non-serializable values
      serialized = JSON.stringify({
        level,
        msg,
        ts: entry.ts,
        ...(this.requestId ? { requestId: this.requestId } : {}),
        _serializationError: true,
      });
    }

    switch (level) {
      case 'error':
        console.error(serialized);
        break;
      case 'warn':
        console.warn(serialized);
        break;
      default:
        console.log(serialized);
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
