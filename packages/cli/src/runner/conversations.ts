// Durable conversations live on the device that ran them: one pi-durable
// SQLite file each, `<dir>/<uuid>.sqlite` (plus SQLite's -wal / -shm). The
// orchestrator only holds the id and pins a resuming turn to this device.
// pi-durable does no cross-process locking and one harness must own a file
// at a time, so turns on one conversation are serialized here; nothing else
// opens these files.

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_RE = /^([0-9a-f-]{36})\.sqlite(?:-wal|-shm)?$/;

export interface ConversationSlot {
  id: string;
  path: string;
  /** The prior conversation exists here and the turn continues it. */
  resumed: boolean;
}

/** The conversation a turn runs in: the prior one when this device has it,
 *  else a fresh id. Ids are validated before they become file names. */
export function pickConversation(dir: string, priorId: string | undefined): ConversationSlot {
  if (priorId !== undefined && ID_RE.test(priorId)) {
    const path = join(dir, `${priorId}.sqlite`);
    if (existsSync(path)) return { id: priorId, path, resumed: true };
  }
  const id = randomUUID();
  return { id, path: join(dir, `${id}.sqlite`), resumed: false };
}

/** Tail of each conversation's turn queue: the release of its newest turn. */
const queues = new Map<string, Promise<void>>();

/** Wait for every earlier turn on `id` to finish; returns this turn's release. */
export async function lockConversation(id: string): Promise<() => void> {
  const previous = queues.get(id);
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  queues.set(id, released);
  await previous;
  return () => {
    if (queues.get(id) === released) queues.delete(id);
    release();
  };
}

/** Delete conversations untouched for `maxAgeMs`, skipping any a turn holds
 *  or waits for. Returns how many were deleted. */
export function pruneConversations(dir: string, maxAgeMs: number, now = Date.now()): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // no conversation stored yet
  }
  const lastTouched = new Map<string, number>();
  for (const name of names) {
    const id = FILE_RE.exec(name)?.[1];
    if (id === undefined) continue;
    const mtime = statSync(join(dir, name), { throwIfNoEntry: false })?.mtimeMs ?? 0;
    lastTouched.set(id, Math.max(lastTouched.get(id) ?? 0, mtime));
  }
  let pruned = 0;
  for (const [id, mtime] of lastTouched) {
    if (now - mtime < maxAgeMs || queues.has(id)) continue;
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(join(dir, `${id}.sqlite${suffix}`), { force: true });
    }
    pruned++;
  }
  return pruned;
}
