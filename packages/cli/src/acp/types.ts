// ACP wire types — minimum needed for the client spike to drive an agent
// through one full round-trip (initialize → session/new → session/prompt →
// stream session/update → terminal stopReason).
//
// Source of truth: zed-industries/agent-client-protocol@0.4.5.
//   schema.json  — https://github.com/zed-industries/agent-client-protocol/blob/main/schema/schema.json
//   docs index   — https://agentclientprotocol.com/
//
// We model only the shapes we actually traffic. Tool-call subfields, plan
// entries, slash commands, mode/model state, and embedded resources are
// out of scope for #27 — they get added in #28/#29 as the integration grows.
// Until then, the rest of the union is captured as `unknown` so unknown
// frames flow through untouched without forcing premature decisions.

// ─── Method names (spec/initialization, spec/prompt-turn) ───────────
//
// Reference: https://agentclientprotocol.com/protocol/overview

export const ACP_METHODS = {
  // Agent methods (client → agent).
  initialize: "initialize",
  session_new: "session/new",
  session_load: "session/load",
  session_prompt: "session/prompt",
  session_cancel: "session/cancel",
  // Client methods (agent → client) — handled minimally in this spike.
  session_update: "session/update",
  session_request_permission: "session/request_permission",
  fs_read_text_file: "fs/read_text_file",
  fs_write_text_file: "fs/write_text_file",
} as const;

export const ACP_PROTOCOL_VERSION = 1;

// ─── Capabilities ───────────────────────────────────────────────────
//
// Reference: https://agentclientprotocol.com/protocol/initialization

export interface FileSystemCapability {
  readTextFile?: boolean;
  writeTextFile?: boolean;
}

export interface ClientCapabilities {
  fs?: FileSystemCapability;
  terminal?: boolean;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  mcpCapabilities?: {
    http?: boolean;
    sse?: boolean;
  };
  promptCapabilities?: {
    audio?: boolean;
    embeddedContext?: boolean;
    image?: boolean;
  };
}

// ─── initialize ────────────────────────────────────────────────────
//
// Reference: https://agentclientprotocol.com/protocol/initialization

export interface InitializeRequest {
  protocolVersion: number;
  clientCapabilities?: ClientCapabilities;
}

export interface InitializeResponse {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  authMethods?: Array<{ id: string; name: string; description?: string | null }>;
}

// ─── session/new ───────────────────────────────────────────────────
//
// Reference: https://agentclientprotocol.com/protocol/session-setup

export interface McpServerStdio {
  type?: "stdio";
  name: string;
  command: string;
  args: string[];
  env?: Array<{ name: string; value: string }>;
}

export type McpServer = McpServerStdio;

export interface NewSessionRequest {
  cwd: string;
  mcpServers: McpServer[];
}

export interface NewSessionResponse {
  sessionId: string;
}

// ─── session/load ──────────────────────────────────────────────────
//
// Reference: https://agentclientprotocol.com/protocol/session-setup
//
// Asks an agent that advertised `loadSession: true` to resume a
// previously created session by id. The shape mirrors `session/new`
// but supplies the id directly. Per spec, the agent MAY emit
// `session/update` notifications during the load to replay history;
// the spike client doesn't depend on that, and our claude-acp shim
// doesn't emit them — the underlying CLI replays internally on the
// next `session/prompt`.

export interface LoadSessionRequest {
  sessionId: string;
  cwd: string;
  mcpServers: McpServer[];
}

// Per spec the response is an empty object today. Modeled as an open
// interface so future extension fields flow through without breaking
// callers (Record<string, never> would be the opposite — it forbids all
// property access and any added field would be a compile error).
export interface LoadSessionResponse {
  [k: string]: unknown;
}

// ─── session/prompt ────────────────────────────────────────────────
//
// Reference: https://agentclientprotocol.com/protocol/prompt-turn

export interface TextContentBlock {
  type: "text";
  text: string;
}

// Full ContentBlock union per schema.json. We only construct text in this
// spike; other variants are present so we can decode an inbound message
// without asserting our way out.
export type ContentBlock =
  | TextContentBlock
  | { type: "image"; data: string; mimeType: string; uri?: string | null }
  | { type: "audio"; data: string; mimeType: string }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      description?: string | null;
      mimeType?: string | null;
      title?: string | null;
      size?: number;
    }
  | { type: "resource"; resource: unknown };

export interface PromptRequest {
  sessionId: string;
  prompt: ContentBlock[];
  /**
   * Opencara extension to the standard ACP `session/prompt` payload:
   * forwards the per-turn `--permission-mode` claude-acp should apply
   * to the underlying `claude` invocation. Other ACP shims that don't
   * understand the field ignore it (standard JSON-RPC extra-field
   * tolerance). Omitted = preserve shim default.
   */
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface PromptResponse {
  stopReason: StopReason;
}

// ─── session/update (notification, agent → client) ─────────────────
//
// Reference: https://agentclientprotocol.com/protocol/prompt-turn#3-agent-reports-output
//
// We type-narrow only the chunk variants the spike consumes for streaming
// text. The other variants (tool_call*, plan, mode/model state, available
// commands) flow through as { sessionUpdate: string; ... } until #28/#29
// pins them down by observation.

export interface MessageChunkUpdate {
  sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
  content: ContentBlock;
}

export interface ToolCallStartUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind?:
    | "read"
    | "edit"
    | "delete"
    | "move"
    | "search"
    | "execute"
    | "think"
    | "fetch"
    | "switch_mode"
    | "other";
  status?: "pending" | "in_progress" | "completed" | "failed";
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
}

export interface ToolCallProgressUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status?: "pending" | "in_progress" | "completed" | "failed" | null;
  title?: string | null;
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
}

export interface UnknownSessionUpdate {
  sessionUpdate: string;
  [k: string]: unknown;
}

export type SessionUpdate =
  | MessageChunkUpdate
  | ToolCallStartUpdate
  | ToolCallProgressUpdate
  | UnknownSessionUpdate;

export interface SessionNotificationParams {
  sessionId: string;
  update: SessionUpdate;
}

// Type guards used by the client to dispatch update events. They narrow the
// union without doing full validation — if a chunk's `content` is malformed,
// the consumer sees the `unknown` shape and can decide what to do.

export function isMessageChunk(u: SessionUpdate): u is MessageChunkUpdate {
  return (
    u.sessionUpdate === "user_message_chunk" ||
    u.sessionUpdate === "agent_message_chunk" ||
    u.sessionUpdate === "agent_thought_chunk"
  );
}

export function isToolCallStart(u: SessionUpdate): u is ToolCallStartUpdate {
  return u.sessionUpdate === "tool_call";
}

export function isToolCallProgress(u: SessionUpdate): u is ToolCallProgressUpdate {
  return u.sessionUpdate === "tool_call_update";
}
