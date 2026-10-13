import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockConversation, pickConversation, pruneConversations } from "../conversations.js";

const DAY = 24 * 60 * 60 * 1000;

function store(...ages: number[]): { dir: string; ids: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "opencara-conversations-"));
  const ids = ages.map((ageMs) => {
    const id = randomUUID();
    const when = (Date.now() - ageMs) / 1000;
    for (const suffix of ["", "-wal", "-shm"]) {
      writeFileSync(join(dir, `${id}.sqlite${suffix}`), "");
      utimesSync(join(dir, `${id}.sqlite${suffix}`), when, when);
    }
    return id;
  });
  return { dir, ids };
}

describe("pickConversation", () => {
  it("continues a stored conversation and refuses ids that aren't conversation ids", () => {
    const { dir, ids } = store(0);
    assert.deepEqual(pickConversation(dir, ids[0]), {
      id: ids[0],
      path: join(dir, `${ids[0]}.sqlite`),
      resumed: true,
    });
    for (const prior of [randomUUID(), "../../etc/passwd", undefined]) {
      const slot = pickConversation(dir, prior);
      assert.equal(slot.resumed, false);
      assert.notEqual(slot.id, prior);
    }
  });
});

describe("lockConversation", () => {
  it("runs turns on one conversation one at a time, in arrival order", async () => {
    const order: string[] = [];
    const releaseFirst = await lockConversation("c");
    const second = lockConversation("c").then((release) => {
      order.push("second");
      release();
    });
    const third = lockConversation("c").then((release) => {
      order.push("third");
      release();
    });
    order.push("first");
    releaseFirst();
    await Promise.all([second, third]);
    assert.deepEqual(order, ["first", "second", "third"]);
  });
});

describe("pruneConversations", () => {
  it("deletes conversations idle past the limit, with their WAL files", () => {
    const { dir, ids } = store(40 * DAY, 2 * DAY);
    assert.equal(pruneConversations(dir, 30 * DAY), 1);
    assert.deepEqual(readdirSync(dir).sort(), [".sqlite", ".sqlite-shm", ".sqlite-wal"].map((s) => `${ids[1]}${s}`));
  });

  it("keeps an old conversation a turn is holding", async () => {
    const { dir, ids } = store(40 * DAY);
    const release = await lockConversation(ids[0]!);
    try {
      assert.equal(pruneConversations(dir, 30 * DAY), 0);
      assert.ok(existsSync(join(dir, `${ids[0]}.sqlite`)));
    } finally {
      release();
    }
  });

  it("is a no-op before anything was stored", () => {
    assert.equal(pruneConversations(join(tmpdir(), randomUUID()), 30 * DAY), 0);
  });
});
