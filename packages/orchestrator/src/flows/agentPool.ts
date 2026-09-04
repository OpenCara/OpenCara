/**
 * Agent pool.
 *
 * An agent node carries an ordered list of candidate agents plus a policy:
 *
 *   concurrency — how many candidates run at once, from the top of the list.
 *   preferred   — how many successes the pool AIMS for: a failed slot is
 *                 refilled from the next unstarted candidate (after
 *                 `retrySame` retries on the same agent) while successes +
 *                 in-flight stay below it and candidates remain. Null means
 *                 "track concurrency", the original slots-are-the-target
 *                 behaviour. Preferred ABOVE concurrency runs the pool in
 *                 waves; below it, the extra slots are never needed and
 *                 concurrency is capped down to it.
 *   quorum      — the minimum successes for the node to count as succeeded.
 *                 The pool never cancels in-flight attempts; it waits for
 *                 them, so a quorum of 1 with concurrency 3 means "run three
 *                 reviewers, keep whatever finished, fail only if all died".
 *
 * The three together are "run `concurrency` at a time, chase `preferred`
 * successes, deliver on `quorum`": 3 / 3 / 2 runs three reviewers in parallel
 * and still delivers when one of them dies.
 *
 * 1 / 1 / 1 is plain priority failover: one agent at a time, first success
 * wins, the list running dry fails the node.
 *
 * Everything here is pure: the caller supplies the attempt function (which
 * owns step rows, dispatch, DB writes) and this module owns only the policy.
 */
import { AgentUnusableError, FlowConfigError, SkipFlowError } from "./errors.js";

/** What the pool does after a failed attempt. */
export type AttemptDisposition =
  /** Try the same candidate again (if `retrySame` budget remains), else next. */
  | "retry"
  /** Skip straight to the next candidate — this one can't work. */
  | "next"
  /** Stop the pool now and surface the error as-is. */
  | "abort";

/**
 * Default policy: skips and config errors abort (they're identical for every
 * candidate); an unusable agent is skipped; anything else (non-zero exit,
 * transport error, timeout) is worth a retry.
 */
export function classifyAttemptError(err: unknown): AttemptDisposition {
  if (err instanceof SkipFlowError) return "abort";
  if (err instanceof FlowConfigError) return "abort";
  if (err instanceof AgentUnusableError) return "next";
  return "retry";
}

/** Clamp bounds accepted from the API / stored settings. */
export const RETRY_SAME_MAX = 5;
export const CONCURRENCY_MAX = 8;

function clampInt(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

export function clampRetrySame(value: unknown): number {
  return clampInt(value, 0, RETRY_SAME_MAX, 0);
}

export function clampConcurrency(value: unknown): number {
  return clampInt(value, 1, CONCURRENCY_MAX, 1);
}

/** Quorum is stored independently; see `effectivePoolShape` for the live cap. */
export function clampQuorum(value: unknown): number {
  return clampInt(value, 1, CONCURRENCY_MAX, 1);
}

/**
 * Preferred successes. Null/absent (the stored default) means "follow
 * `concurrency`" — every pool configured before this knob existed keeps the
 * exact shape it had, where the slot count WAS the target.
 */
export function clampPreferred(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(CONCURRENCY_MAX, Math.max(1, Math.trunc(n)));
}

/**
 * The shape a pool will ACTUALLY run with, derived from the stored settings:
 *   - preferred (defaulting to `concurrency`) never exceeds the candidate
 *     count — no more successes can be produced than there are agents.
 *   - concurrency never exceeds the candidate count, nor `preferred`: a slot
 *     beyond the target would start an attempt nobody needs.
 *   - quorum never exceeds `preferred` — it counts successes, and the pool
 *     stops starting attempts once `preferred` of them succeeded.
 *
 * Worktree nodes are NOT capped any more: every attempt allocates its own
 * checkout (keyed by its flow_run_steps id), so parallel slots never share a
 * working tree.
 *
 * `runWithAgentPool` re-applies the same caps defensively, but the caller
 * must persist THESE numbers as the attempt's pool meta: a raw quorum above
 * the slot count made the run page paint a succeeded reviewer node as failed
 * (opencara run 01M1GQ7K1NMS90ERCNWZWVNP5V).
 */
export function effectivePoolShape(input: {
  concurrency: unknown;
  preferred?: unknown;
  quorum: unknown;
  candidateCount: number;
}): { concurrency: number; preferred: number; quorum: number; quorumCapped: boolean } {
  const requestedConcurrency = clampConcurrency(input.concurrency);
  const room = Math.max(1, input.candidateCount);
  const preferred = Math.min(clampPreferred(input.preferred) ?? requestedConcurrency, room);
  const concurrency = Math.min(requestedConcurrency, room, preferred);
  const requestedQuorum = clampQuorum(input.quorum);
  const quorum = Math.min(requestedQuorum, preferred);
  return { concurrency, preferred, quorum, quorumCapped: quorum < requestedQuorum };
}

/**
 * Build the ordered candidate id list for a node.
 *
 *   pinned   — the label-routed agent or the project default implement
 *              agent (the pre-pool precedence tiers). Runs first when set.
 *   primary  — `flow_node_settings.agent_id`.
 *   fallbacks— `flow_node_settings.fallback_agent_ids`, in stored order.
 *
 * Duplicates collapse onto their first position so a pinned agent that also
 * appears in the node list is never tried twice.
 */
export function orderPoolCandidates(input: {
  pinned: string | null | undefined;
  primary: string | null | undefined;
  fallbacks: readonly string[] | null | undefined;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | null | undefined) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  push(input.pinned);
  push(input.primary);
  for (const id of input.fallbacks ?? []) push(id);
  return out;
}

export interface PoolAttemptInfo {
  /** 0-based ordinal across the whole pool run (== step row `attempt`). */
  attempt: number;
  /** Index into the candidate list. */
  candidateIndex: number;
  /** 0 for the first try on this candidate, 1.. for retries. */
  retryIndex: number;
  candidateCount: number;
}

export interface PoolAttemptRecord<C> {
  candidate: C;
  info: PoolAttemptInfo;
  error: unknown;
  disposition: AttemptDisposition;
}

export interface PoolSuccess<C, T> {
  candidate: C;
  info: PoolAttemptInfo;
  value: T;
}

export class AgentPoolExhaustedError extends Error {
  constructor(
    public readonly attempts: readonly PoolAttemptRecord<unknown>[],
    public readonly successes: number,
    public readonly quorum: number,
    describe: (candidate: unknown) => string,
  ) {
    const last = attempts[attempts.length - 1];
    const lastMsg = last ? errorMessage(last.error) : "no candidates";
    const trail = attempts
      .map((a) => `${describe(a.candidate)}#${a.info.retryIndex + 1}: ${errorMessage(a.error)}`)
      .join("; ");
    super(
      attempts.length <= 1 && successes === 0
        ? lastMsg
        : `agent pool exhausted: ${successes}/${quorum} needed succeeded after ${attempts.length} failed attempt${attempts.length === 1 ? "" : "s"} — last: ${lastMsg} [${trail}]`,
    );
    this.name = "AgentPoolExhaustedError";
  }
}

export interface RunWithAgentPoolOpts<C, T> {
  candidates: readonly C[];
  retrySame: number;
  /** Parallel slots. Default 1. */
  concurrency?: number;
  /** Successes to aim for. Default/null = `concurrency`. */
  preferred?: number | null;
  /** Minimum successes to succeed. Default 1; capped to the live target. */
  quorum?: number;
  /** Runs one attempt. Throwing = failed attempt; resolving = success. */
  attempt: (candidate: C, info: PoolAttemptInfo) => Promise<T>;
  classify?: (err: unknown) => AttemptDisposition;
  describe?: (candidate: C) => string;
  /** Observability hook, called after each failed (non-abort) attempt. */
  onAttemptFailed?: (record: PoolAttemptRecord<C>) => void;
}

export interface PoolResult<C, T> {
  /** Successful attempts in completion order (≥ quorum of them). */
  successes: PoolSuccess<C, T>[];
  failures: PoolAttemptRecord<C>[];
  /** Effective numbers after clamping to the candidate list. */
  concurrency: number;
  /** Successes the pool aimed for (the effective `preferred`). */
  target: number;
  quorum: number;
}

interface Settled<C, T> {
  id: number;
  task: { candidate: C; info: PoolAttemptInfo };
  ok: boolean;
  value?: T;
  error?: unknown;
}

/**
 * Drive the pool. Resolves once every slot has settled and at least `quorum`
 * attempts succeeded; throws `AgentPoolExhaustedError` when the candidate
 * list is spent below quorum. Between quorum and `preferred` the pool keeps
 * refilling from the candidate list, so falling back to quorum costs nothing
 * while agents remain — it is the floor, not the goal. An `abort` disposition
 * rethrows the error at once — in-flight attempts are left to settle on their
 * own (their step rows still get finalised by the attempt function) and their
 * outcomes dropped.
 */
export async function runWithAgentPool<C, T>(
  opts: RunWithAgentPoolOpts<C, T>,
): Promise<PoolResult<C, T>> {
  const classify = opts.classify ?? classifyAttemptError;
  const describe = opts.describe ?? ((c: C) => String(c));
  const retrySame = clampRetrySame(opts.retrySame);
  const candidateCount = opts.candidates.length;
  const requestedConcurrency = clampConcurrency(opts.concurrency ?? 1);
  // `target` is the successes aimed for; `parallel` how many chase them at
  // once. Both are bounded by the candidate list — with none, target is 0 and
  // the pool fails on the empty tally below rather than starting anything.
  const target = Math.min(clampPreferred(opts.preferred) ?? requestedConcurrency, candidateCount);
  const parallel = Math.min(requestedConcurrency, target);
  const quorum = Math.min(clampQuorum(opts.quorum ?? 1), Math.max(target, 1));

  // Work queue in priority order. A retry is pushed to the FRONT so the same
  // agent is tried again before the next candidate starts.
  const pending: Array<{ candidate: C; candidateIndex: number; retryIndex: number }> =
    opts.candidates.map((candidate, candidateIndex) => ({ candidate, candidateIndex, retryIndex: 0 }));
  const inFlight = new Map<number, Promise<Settled<C, T>>>();
  const successes: PoolSuccess<C, T>[] = [];
  const failures: PoolAttemptRecord<C>[] = [];
  let attempt = 0;

  const start = (job: (typeof pending)[number]) => {
    const id = attempt++;
    const info: PoolAttemptInfo = {
      attempt: id,
      candidateIndex: job.candidateIndex,
      retryIndex: job.retryIndex,
      candidateCount,
    };
    const task = { candidate: job.candidate, info };
    const p: Promise<Settled<C, T>> = Promise.resolve()
      .then(() => opts.attempt(job.candidate, info))
      .then(
        (value) => ({ id, task, ok: true, value }),
        (error: unknown) => ({ id, task, ok: false, error }),
      );
    inFlight.set(id, p);
  };

  for (;;) {
    while (
      inFlight.size < parallel &&
      successes.length + inFlight.size < target &&
      pending.length > 0
    ) {
      start(pending.shift()!);
    }
    if (inFlight.size === 0) break;
    const settled = await Promise.race(inFlight.values());
    inFlight.delete(settled.id);
    if (settled.ok) {
      successes.push({ candidate: settled.task.candidate, info: settled.task.info, value: settled.value as T });
      continue;
    }
    const disposition = classify(settled.error);
    if (disposition === "abort") {
      // Detach the rest: they settle into their own step rows, nobody awaits.
      for (const p of inFlight.values()) void p.catch(() => undefined);
      throw settled.error;
    }
    const record: PoolAttemptRecord<C> = {
      candidate: settled.task.candidate,
      info: settled.task.info,
      error: settled.error,
      disposition,
    };
    failures.push(record);
    opts.onAttemptFailed?.(record);
    if (disposition === "retry" && settled.task.info.retryIndex < retrySame) {
      pending.unshift({
        candidate: settled.task.candidate,
        candidateIndex: settled.task.info.candidateIndex,
        retryIndex: settled.task.info.retryIndex + 1,
      });
    }
  }

  if (successes.length >= quorum && successes.length > 0) {
    return { successes, failures, concurrency: parallel, target, quorum };
  }
  throw new AgentPoolExhaustedError(failures, successes.length, quorum, (c) => describe(c as C));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
