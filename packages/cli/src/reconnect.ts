export interface ReconnectOptions {
  initialDelay: number;
  maxDelay: number;
  multiplier: number;
  jitter: boolean;
}

export const DEFAULT_RECONNECT_OPTIONS: ReconnectOptions = {
  initialDelay: 1000,
  maxDelay: 30000,
  multiplier: 2,
  jitter: true,
};

export function calculateDelay(
  attempt: number,
  options: ReconnectOptions = DEFAULT_RECONNECT_OPTIONS,
): number {
  const base = Math.min(
    options.initialDelay * Math.pow(options.multiplier, attempt),
    options.maxDelay,
  );
  if (options.jitter) {
    return base + Math.random() * 500;
  }
  return base;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
