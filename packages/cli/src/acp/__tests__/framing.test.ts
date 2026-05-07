import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FrameDecoder, encodeFrame } from "../framing.js";
import type { JsonRpcRequest, JsonRpcSuccess } from "../jsonrpc.js";

describe("encodeFrame", () => {
  it("appends \\n and emits compact JSON", () => {
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    };
    const wire = encodeFrame(req);
    assert.equal(wire.endsWith("\n"), true);
    assert.equal(wire.includes(" "), false, "must be compact (no whitespace)");
    assert.deepEqual(JSON.parse(wire.trimEnd()), req);
  });
});

describe("FrameDecoder", () => {
  it("parses one complete frame", () => {
    const dec = new FrameDecoder();
    const { messages, malformed } = dec.feed('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
    assert.equal(messages.length, 1);
    assert.equal(malformed.length, 0);
    const m = messages[0] as JsonRpcSuccess;
    assert.equal(m.id, 1);
    assert.deepEqual(m.result, { ok: true });
  });

  it("parses multiple frames in one chunk", () => {
    const dec = new FrameDecoder();
    const { messages } = dec.feed(
      '{"jsonrpc":"2.0","id":1,"result":{}}\n' +
        '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1"}}\n',
    );
    assert.equal(messages.length, 2);
  });

  it("buffers partial frames across feeds", () => {
    const dec = new FrameDecoder();
    const r1 = dec.feed('{"jsonrpc":"2.0","i');
    assert.equal(r1.messages.length, 0);
    const r2 = dec.feed('d":1,"result":1}\n');
    assert.equal(r2.messages.length, 1);
    assert.equal(dec.remainder(), "");
  });

  it("buffers a partial trailing line and parses it on the next \\n", () => {
    const dec = new FrameDecoder();
    const r1 = dec.feed('{"jsonrpc":"2.0","id":1,"result":1}\n{"jsonrpc":"2.0","id":2,"result":');
    assert.equal(r1.messages.length, 1);
    assert.notEqual(dec.remainder(), "");
    const r2 = dec.feed("2}\n");
    assert.equal(r2.messages.length, 1);
    assert.equal((r2.messages[0] as JsonRpcSuccess).result, 2);
  });

  it("drops empty lines silently", () => {
    const dec = new FrameDecoder();
    const { messages, malformed } = dec.feed('\n\n{"jsonrpc":"2.0","id":1,"result":1}\n\n');
    assert.equal(messages.length, 1);
    assert.equal(malformed.length, 0);
  });

  it("collects malformed lines without aborting", () => {
    const dec = new FrameDecoder();
    const { messages, malformed } = dec.feed(
      "garbage line\n" +
        '{"jsonrpc":"2.0","id":1,"result":1}\n' +
        '"not an object"\n' +
        '{"jsonrpc":"2.0","id":2,"result":2}\n',
    );
    assert.equal(messages.length, 2);
    assert.equal(malformed.length, 2);
    assert.equal(malformed[0], "garbage line");
    assert.equal(malformed[1], '"not an object"');
  });

  it("rejects bare arrays as malformed (we expect objects on the wire)", () => {
    const dec = new FrameDecoder();
    const { messages, malformed } = dec.feed("[1,2,3]\n");
    assert.equal(messages.length, 0);
    assert.equal(malformed.length, 1);
  });
});
