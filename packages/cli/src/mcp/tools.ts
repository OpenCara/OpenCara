// MCP tool definitions for opencara mutations.
//
// Three tools mirror the existing `agent-call` allowlist (the per-page
// mutations the chat skills hand to agents):
//   - opencara_issue_body_set
//   - opencara_flow_node_config_set
//   - opencara_template_node_config_set
//
// Naming: MCP tool names must be a single identifier (the protocol
// recommends `^[a-zA-Z0-9_-]+$`). The wire `kind` strings keep their
// dot-notation (`issue.body.set`) so the orchestrator's allowlist and
// switch in `dispatch/devices.ts:applyAgentCall` don't change. The
// tool name → kind mapping is captured here in one place so both ends
// stay in lockstep.
//
// Schemas: input shapes are extracted from the existing zod schemas in
// @opencara/shared by stripping the envelope fields (`type`, `runId`,
// `callId`, `kind`). The MCP SDK accepts ZodRawShape objects; we keep
// each shape as a plain `{key: ZodSchema}` map so the SDK can derive
// JSON Schema for the agent's tool list.
//
// Handlers delegate to a `ToolCallRouter` injected at registration time.
// The router proxies the call back to the orchestrator (over the device
// WS in production, over a mock channel in tests) and returns the
// result. Production wiring lives in the opencara-mcp binary.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  IssueBodySetCallSchema,
  FlowNodeConfigSetCallSchema,
  TemplateNodeConfigSetCallSchema,
  KanbanWaveDispatchCallSchema,
  IssueSubissueCreateCallSchema,
  IssueCreateCallSchema,
  IssueStateSetCallSchema,
  IssueCommentCreateCallSchema,
  IssueLabelsSetCallSchema,
} from "@opencara/shared";

/**
 * Result returned by the orchestrator for an applied (or rejected)
 * mutation. Mirrors `AgentCallResult` in
 * `packages/orchestrator/src/agent-calls/index.ts`.
 */
export type ToolCallResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Injected at registration time so unit tests can drive the server with a
 * deterministic in-memory router (no IPC / WS in the loop). The production
 * router (in opencara-mcp) forwards calls over the IPC socket to the
 * running CLI device.
 *
 * Implementations MUST NOT throw on a domain-level rejection (unknown
 * issue, scope violation, etc.) — surface those as `{ ok: false }`.
 * `throw` is reserved for transport-level failure (IPC dropped, etc.).
 */
export interface ToolCallRouter {
  call(kind: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

// ─── Tool definitions ──────────────────────────────────────────────

interface ToolDef<Shape extends z.ZodRawShape> {
  name: string;
  kind: string;
  title: string;
  description: string;
  inputShape: Shape;
}

// Strip envelope fields (`type`, `runId`, `callId`, `kind`) from each
// shared schema and lift the remaining ZodObject's `.shape` so we can
// pass it as the SDK's ZodRawShape.
const issueBodySetShape = IssueBodySetCallSchema.omit({
  type: true,
  runId: true,
  callId: true,
  kind: true,
}).shape;

const flowNodeConfigSetShape = FlowNodeConfigSetCallSchema.omit({
  type: true,
  runId: true,
  callId: true,
  kind: true,
}).shape;

const templateNodeConfigSetShape = TemplateNodeConfigSetCallSchema.omit({
  type: true,
  runId: true,
  callId: true,
  kind: true,
}).shape;

const kanbanWaveDispatchShape = KanbanWaveDispatchCallSchema.omit({
  type: true,
  runId: true,
  callId: true,
  kind: true,
}).shape;

const issueSubissueCreateShape = IssueSubissueCreateCallSchema.omit({
  type: true,
  runId: true,
  callId: true,
  kind: true,
}).shape;

const issueCreateShape = IssueCreateCallSchema.omit({
  type: true,
  runId: true,
  callId: true,
  kind: true,
}).shape;

const issueStateSetShape = IssueStateSetCallSchema.omit({
  type: true,
  runId: true,
  callId: true,
  kind: true,
}).shape;

const issueCommentCreateShape = IssueCommentCreateCallSchema.omit({
  type: true,
  runId: true,
  callId: true,
  kind: true,
}).shape;

const issueLabelsSetShape = IssueLabelsSetCallSchema.omit({
  type: true,
  runId: true,
  callId: true,
  kind: true,
}).shape;

export const TOOLS = [
  {
    name: "opencara_issue_body_set",
    kind: "issue.body.set",
    title: "Update an issue body draft",
    description:
      "Replace the draft Markdown body of an issue in the run's project. " +
      "The change goes to the draft store — the user must publish to GitHub " +
      "from the canvas. Reject with reason if the issue isn't in the run's " +
      "project scope.",
    inputShape: issueBodySetShape,
  },
  {
    name: "opencara_flow_node_config_set",
    kind: "flow.node.config.set",
    title: "Update a flow node's config",
    description:
      "Replace the config blob of a node in the named flow within the run's " +
      "project. Reject with reason if the flow or node doesn't exist or is " +
      "out of scope.",
    inputShape: flowNodeConfigSetShape,
  },
  {
    name: "opencara_template_node_config_set",
    kind: "template.node.config.set",
    title: "Update a flow-template draft node's config",
    description:
      "Replace the config blob of a node in the user's draft of the named " +
      "flow template. Per-user scope, not per-project. Reject with reason " +
      "if the template draft isn't owned by the run's user.",
    inputShape: templateNodeConfigSetShape,
  },
  {
    name: "opencara_kanban_wave_dispatch",
    kind: "kanban.wave.dispatch",
    title: "Dispatch a batch of issues to a flow",
    description:
      "Dispatch up to 10 issues in parallel to the named project flow. " +
      "Requires project scope. Reject if the flow does not exist, is disabled, " +
      "or any of the issue numbers are not in the project. Returns the wave id.",
    inputShape: kanbanWaveDispatchShape,
  },
  {
    name: "opencara_issue_subissue_create",
    kind: "issue.subissue.create",
    title: "Create a GitHub sub-issue under a parent",
    description:
      "Create a new GitHub issue and link it as a child of the given parent issue " +
      "via the GraphQL addSubIssue mutation. Requires project scope. Reject if the " +
      "parent issue is not in the project.",
    inputShape: issueSubissueCreateShape,
  },
  {
    name: "opencara_issue_create",
    kind: "issue.create",
    title: "Create a top-level GitHub issue",
    description:
      "Create a new GitHub issue in the run's project with no parent link. " +
      "Requires project scope. Returns the new issueNumber and nodeId.",
    inputShape: issueCreateShape,
  },
  {
    name: "opencara_issue_state_set",
    kind: "issue.state.set",
    title: "Open or close an existing issue",
    description:
      "Set an issue's state to open or closed. Optional stateReason: " +
      "completed | not_planned | reopened. Requires project scope. " +
      "Reject if the issue is not in the project.",
    inputShape: issueStateSetShape,
  },
  {
    name: "opencara_issue_comment_create",
    kind: "issue.comment.create",
    title: "Post a comment on an issue",
    description:
      "Post a Markdown comment on the named issue. Comments are not " +
      "mirrored locally; the comment lives on GitHub. Requires project " +
      "scope. Reject if the issue is not in the project.",
    inputShape: issueCommentCreateShape,
  },
  {
    name: "opencara_issue_labels_set",
    kind: "issue.labels.set",
    title: "Replace the label set on an issue",
    description:
      "Set the issue's labels to exactly the listed names (REST setLabels " +
      "semantics). Any label not in the list is removed; empty array clears " +
      "all labels. Requires project scope.",
    inputShape: issueLabelsSetShape,
  },
] as const satisfies ReadonlyArray<ToolDef<z.ZodRawShape>>;

// ─── Registration ──────────────────────────────────────────────────

/**
 * Register all opencara mutation tools on the given MCP server. Each
 * handler captures `router` and forwards the call. The MCP SDK validates
 * input args against `inputShape` before invoking the handler, so the
 * orchestrator-side schema check (in `dispatch/devices.ts`) is a defense
 * in depth, not the primary gate.
 */
export function registerOpencaraTools(server: McpServer, router: ToolCallRouter): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
      },
      async (args: Record<string, unknown>) => {
        const result = await router.call(tool.kind, args);
        if (result.ok) {
          return {
            content: [{ type: "text" as const, text: "ok" }],
          };
        }
        return {
          content: [{ type: "text" as const, text: `rejected: ${result.reason}` }],
          isError: true,
        };
      },
    );
  }
}

/** Test/spike helper: list of (name, kind) pairs for assertions. */
export const TOOL_NAMES = TOOLS.map((t) => ({ name: t.name, kind: t.kind }));
