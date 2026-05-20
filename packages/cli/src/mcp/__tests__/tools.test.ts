// Verifies tool registration shape and kind↔name mapping. Doesn't bring up
// a real MCP transport — the SDK is upstream-tested. We just confirm:
//   1. TOOLS covers the agent-call kinds we ship.
//   2. registerOpencaraTools wires each tool's name + handler so the
//      handler delegates to the injected router.
//
// This avoids the SDK's stdio transport entirely: we instantiate an
// McpServer, register tools, and capture handlers off the
// _registeredTools internal map (the SDK exposes it; if it goes private
// in a future minor we'll switch to driving the server with a fake
// transport).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerOpencaraTools,
  TOOL_NAMES,
  TOOLS,
  type ToolCallResult,
  type ToolCallRouter,
} from "../tools.js";

const EXPECTED_KINDS = [
  "flow.node.config.set",
  "issue.body.set",
  "issue.comment.create",
  "issue.create",
  "issue.labels.set",
  "issue.state.set",
  "issue.subissue.create",
  "kanban.wave.dispatch",
  "template.node.config.set",
] as const;

const EXPECTED_NAMES = [
  "opencara_flow_node_config_set",
  "opencara_issue_body_set",
  "opencara_issue_comment_create",
  "opencara_issue_create",
  "opencara_issue_labels_set",
  "opencara_issue_state_set",
  "opencara_issue_subissue_create",
  "opencara_kanban_wave_dispatch",
  "opencara_template_node_config_set",
] as const;

describe("TOOLS registry", () => {
  it("ships every agent-call kind we expose", () => {
    assert.equal(TOOLS.length, EXPECTED_KINDS.length);
    const kinds = TOOLS.map((t) => t.kind).sort();
    assert.deepEqual(kinds, [...EXPECTED_KINDS]);
  });

  it("kind↔name mapping is symmetric and stable", () => {
    const map = new Map(TOOL_NAMES.map((t) => [t.kind, t.name]));
    for (const kind of EXPECTED_KINDS) {
      const name = map.get(kind);
      assert.ok(name, `missing tool name for kind ${kind}`);
      assert.equal(name, `opencara_${kind.replaceAll(".", "_")}`);
    }
  });

  it("MCP tool names match the protocol's identifier rules", () => {
    // ^[a-zA-Z0-9_-]+$ per the MCP spec. Catches an accidental dot in
    // a future kind addition.
    const re = /^[a-zA-Z0-9_-]+$/;
    for (const t of TOOLS) {
      assert.match(t.name, re, `tool name ${t.name} fails identifier rules`);
    }
  });
});

describe("registerOpencaraTools", () => {
  function setup(): {
    server: McpServer;
    calls: Array<{ kind: string; args: Record<string, unknown> }>;
    nextResult: { value: ToolCallResult };
  } {
    const server = new McpServer({ name: "test", version: "0" });
    const calls: Array<{ kind: string; args: Record<string, unknown> }> = [];
    const nextResult = { value: { ok: true } as ToolCallResult };
    const router: ToolCallRouter = {
      async call(kind, args) {
        calls.push({ kind, args });
        return nextResult.value;
      },
    };
    registerOpencaraTools(server, router);
    return { server, calls, nextResult };
  }

  it("registers every tool on the server", () => {
    const { server } = setup();
    // McpServer exposes the registered tool map as `_registeredTools`.
    // Best-effort introspection — if the SDK refactors this, we'll see
    // the test break loudly.
    const internal = server as unknown as {
      _registeredTools: Record<string, unknown>;
    };
    const names = Object.keys(internal._registeredTools).sort();
    assert.deepEqual(names, [...EXPECTED_NAMES]);
  });

  it("forwards a successful tool call to the router and returns ok content", async () => {
    const { server, calls, nextResult } = setup();
    nextResult.value = { ok: true };
    const internal = server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    };
    const tool = internal._registeredTools["opencara_issue_body_set"]!;
    const out = (await tool.handler({ issueNumber: 7, bodyMd: "hi" })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.kind, "issue.body.set");
    assert.deepEqual(calls[0]!.args, { issueNumber: 7, bodyMd: "hi" });
    assert.equal(out.content[0]!.text, "ok");
    assert.equal(out.isError, undefined);
  });

  it("translates a domain rejection into an error result with the reason", async () => {
    const { server, nextResult } = setup();
    nextResult.value = { ok: false, reason: "issue #99 not in project" };
    const internal = server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<unknown> }
      >;
    };
    const tool = internal._registeredTools["opencara_issue_body_set"]!;
    const out = (await tool.handler({ issueNumber: 99, bodyMd: "bad" })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    assert.equal(out.isError, true);
    assert.match(out.content[0]!.text, /rejected: issue #99 not in project/);
  });
});
