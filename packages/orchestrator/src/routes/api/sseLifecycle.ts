export type SseCleanup = () => void | Promise<void>;

/** Idempotent cleanup registry that also disposes resources added after abort. */
export class SseLifecycle {
  private cleanups: SseCleanup[] = [];
  private cleanupPromise: Promise<void> | null = null;
  closed = false;

  add(cleanup: SseCleanup): void {
    if (this.closed) {
      void Promise.resolve().then(cleanup).catch(() => undefined);
      return;
    }
    this.cleanups.push(cleanup);
  }

  cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.closed = true;
    const cleanups = this.cleanups.splice(0).reverse();
    this.cleanupPromise = Promise.allSettled(cleanups.map(async (cleanup) => cleanup())).then(
      () => undefined,
    );
    return this.cleanupPromise;
  }
}
