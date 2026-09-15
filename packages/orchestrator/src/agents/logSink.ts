import type { Sql } from "postgres";
import type { Db } from "../db/client.js";
import { agentRunLogs } from "../db/schema.js";
import type { LogStream } from "../dispatch/dispatcher.js";

export interface AgentLogSinkOptions {
  /**
   * Max time a buffered chunk waits before being flushed. The SSE log
   * stream only learns about rows via the post-insert NOTIFY, so this is
   * also the worst-case added latency between the agent emitting a chunk
   * and a subscriber seeing it. Kept sub-second so the live tail still
   * feels live.
   */
  flushIntervalMs?: number;
  /**
   * Buffer-size flush trigger. Agents emit token-level deltas during
   * "thinking"; without a byte cap a verbose run would hold hundreds of
   * chunks in memory between timer flushes.
   */
  maxFlushBytes?: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 300;
const DEFAULT_MAX_FLUSH_BYTES = 64 * 1024;

interface PendingChunk {
  seq: number;
  stream: LogStream;
  chunk: string;
}

/**
 * Batched `agent_run_logs` writer for one agent run.
 *
 * Why this exists (OpenCara#245): every call site used to persist each
 * streamed chunk with a fire-and-forget `insert` + `pg_notify`. Under a
 * chatty agent that's two pool checkouts per chunk — and the promises are
 * unbounded, so a burst piles arbitrarily many in-flight inserts onto the
 * 12-connection pool. Every pooled query also pays the ~57ms WAN round
 * trip to the hosted pooler, so each chunk pinned a connection for ~60ms+
 * and contributed directly to the acquire-queue stalls that turned
 * session lookups into 503s.
 *
 * The sink buffers chunks and flushes with ONE multi-row insert + ONE
 * notify, serialized through a promise chain so a run has at most one
 * outstanding DB operation at a time (implicit backpressure: DB slowness
 * grows the in-memory buffer instead of the in-flight query count). A
 * failed flush logs and drops its rows — run logs are diagnostic data and
 * a retry storm is worse than a gap; matches the prior best-effort
 * contract.
 *
 * Lifecycle: `push` per chunk (signature matches `RunContext.onLog`),
 * then `await sink.close()` once the dispatcher resolves, BEFORE the
 * caller's terminal status write — the SSE end event goes out on the
 * status change, so all chunks must be durable first.
 */
export class AgentLogSink {
  private seq = 0;
  private pending: PendingChunk[] = [];
  private pendingBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly flushIntervalMs: number;
  private readonly maxFlushBytes: number;

  constructor(
    private readonly db: Db,
    private readonly pg: Sql,
    private readonly agentRunId: string,
    opts: AgentLogSinkOptions = {},
  ) {
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxFlushBytes = opts.maxFlushBytes ?? DEFAULT_MAX_FLUSH_BYTES;
  }

  /**
   * Buffer one chunk. Matches `RunContext.onLog`'s signature so call
   * sites can pass `sink.push` directly.
   */
  readonly push = (stream: LogStream, chunk: string): void => {
    // Chunks arriving after close() are dropped — the dispatcher contract
    // fires every onLog before run() resolves, so this only triggers on a
    // misbehaving dispatcher; silently dropping matches the old
    // fire-and-forget semantics.
    if (this.closed) return;
    this.pending.push({ seq: this.seq++, stream, chunk });
    this.pendingBytes += chunk.length;
    if (this.pendingBytes >= this.maxFlushBytes) {
      this.clearTimer();
      this.enqueueFlush();
    } else {
      this.armTimer();
    }
  };

  /** Flush whatever is buffered now (still serialized behind in-flight writes). */
  flushNow(): Promise<void> {
    this.clearTimer();
    return this.enqueueFlush();
  }

  /** Stop accepting chunks, flush the remainder, resolve when durable. */
  async close(): Promise<void> {
    this.closed = true;
    this.clearTimer();
    await this.enqueueFlush();
  }

  private armTimer(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueueFlush();
    }, this.flushIntervalMs);
    // A buffered log tail must never hold the process open on its own.
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private enqueueFlush(): Promise<void> {
    // Serialize: each drain runs after the previous settles. Errors are
    // absorbed inside drain(), so the chain never breaks.
    this.chain = this.chain.then(() => this.drain());
    return this.chain;
  }

  private async drain(): Promise<void> {
    const rows = this.pending;
    if (rows.length === 0) return;
    this.pending = [];
    this.pendingBytes = 0;
    try {
      await this.db
        .insert(agentRunLogs)
        .values(
          rows.map((r) => ({
            agentRunId: this.agentRunId,
            seq: r.seq,
            stream: r.stream,
            chunk: r.chunk,
          })),
        );
      // One notify per batch: subscribers re-SELECT `seq > lastSeq`, so a
      // single wake-up already covers every row in the flush.
      await this.pg.notify("agent_run_logs", this.agentRunId);
    } catch (err) {
      console.error(
        `[logs] agent_run_logs flush failed for run ${this.agentRunId} (${rows.length} chunk(s) dropped)`,
        err,
      );
    }
  }
}
