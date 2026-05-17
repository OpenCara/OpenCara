import { z } from "zod";
import { AgentRunSchema, AgentSpecSchema } from "./agent.js";

// ─── Pairing (HTTP) ──────────────────────────────────────────────────

export const PairingCreateRequestSchema = z.object({
  device_secret_hash: z.string(),
});
export type PairingCreateRequest = z.infer<typeof PairingCreateRequestSchema>;

export const PairingCreateResponseSchema = z.object({
  code: z.string(),
  expires_at: z.string().datetime(),
});
export type PairingCreateResponse = z.infer<typeof PairingCreateResponseSchema>;

export const PairingStatusResponseSchema = z.union([
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("confirmed"),
    token: z.string(),
    agent_host_id: z.string(),
    device_name: z.string(),
  }),
  z.object({ status: z.literal("expired") }),
]);
export type PairingStatusResponse = z.infer<typeof PairingStatusResponseSchema>;

export const PairingConfirmRequestSchema = z.object({
  device_name: z.string().min(1),
});
export type PairingConfirmRequest = z.infer<typeof PairingConfirmRequestSchema>;

// ─── Device WebSocket transport ──────────────────────────────────────

/**
 * Best-effort device system metrics, collected once at connect. Never used
 * for routing decisions — purely for the operator's "what hardware do I
 * have paired" view in the dashboard.
 */
export const SystemInfoSchema = z.object({
  os: z.string(),                                // os.platform()
  release: z.string(),                           // os.release()
  arch: z.string(),                              // os.arch()
  hostname: z.string(),
  cpu: z.object({
    model: z.string(),
    cores: z.number().int().nonnegative(),
    speedMhz: z.number().int().nonnegative(),
  }),
  memory: z.object({
    totalBytes: z.number().nonnegative(),
    freeBytes: z.number().nonnegative(),
  }),
  disk: z
    .object({
      path: z.string(),
      totalBytes: z.number().nonnegative(),
      freeBytes: z.number().nonnegative(),
    })
    .optional(),
  ipAddrs: z.array(z.string()).default([]),
  uptimeSec: z.number().nonnegative(),
});
export type SystemInfo = z.infer<typeof SystemInfoSchema>;

/** Device → server when the WS opens. */
export const HelloMessageSchema = z.object({
  type: z.literal("hello"),
  platform: z.string(),
  version: z.string(),
  capabilities: z.array(z.string()).default([]),
  systemInfo: SystemInfoSchema.optional(),
});
export type HelloMessage = z.infer<typeof HelloMessageSchema>;

/** Server → device. */
export const JobAssignmentSchema = z.object({
  type: z.literal("job"),
  run: AgentRunSchema,
  spec: AgentSpecSchema,
  stdinJson: z.unknown().optional(),
});
export type JobAssignment = z.infer<typeof JobAssignmentSchema>;

/** Device → server: a chunk of agent stdout/stderr. */
export const LogFrameSchema = z.object({
  type: z.literal("log"),
  runId: z.string(),
  seq: z.number().int().min(0),
  stream: z.enum(["stdout", "stderr"]),
  chunk: z.string(),
});
export type LogFrame = z.infer<typeof LogFrameSchema>;

/** Device → server: terminal status of a job. */
export const RunDoneSchema = z.object({
  type: z.literal("done"),
  runId: z.string(),
  status: z.enum(["succeeded", "failed", "cancelled"]),
  exitCode: z.number().int().nullable().optional(),
  errorMessage: z.string().optional(),
  /** ACP session id the agent ran under (fresh from session/new, or
   *  echoed from session/load). The orchestrator persists this per
   *  (repo, branch) so the next iteration can resume via session/load.
   *  Null/absent for non-ACP runs (worktree-allocate, write-session). */
  acpSessionId: z.string().nullable().optional(),
});
export type RunDone = z.infer<typeof RunDoneSchema>;

/** Server → device: ack of hello, optional config. */
export const HelloAckSchema = z.object({
  type: z.literal("hello-ack"),
  agentHostId: z.string(),
  deviceName: z.string(),
});
export type HelloAck = z.infer<typeof HelloAckSchema>;

/** Server → device: heartbeat ping. */
export const PingSchema = z.object({ type: z.literal("ping") });
/** Device → server: pong. */
export const PongSchema = z.object({ type: z.literal("pong") });

/**
 * Per-mutation payload schemas. Pre-#30 these were also the wire shapes
 * for the fire-and-forget `agent-call` WS variant (the fenced-stdout-
 * block protocol the CLI parsed via `agentCallParser.ts`); that
 * variant was removed in #30 along with the parser. The schemas stay
 * because they're the input to `applyIssue/Flow/TemplateBodySet` in
 * `agent-calls/index.ts`, and they're parameterized as
 * `AgentCallRequest` below for the ACP request/response path.
 */
const AgentCallEnvelope = {
  type: z.literal("agent-call"),
  runId: z.string(),
  callId: z.string(),
};

export const IssueBodySetCallSchema = z.object({
  ...AgentCallEnvelope,
  kind: z.literal("issue.body.set"),
  issueNumber: z.number().int(),
  bodyMd: z.string(),
});
export type IssueBodySetCall = z.infer<typeof IssueBodySetCallSchema>;

/** Replace a flow node's config blob (project-scoped). */
export const FlowNodeConfigSetCallSchema = z.object({
  ...AgentCallEnvelope,
  kind: z.literal("flow.node.config.set"),
  flowSlug: z.string().min(1),
  nodeId: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
});
export type FlowNodeConfigSetCall = z.infer<typeof FlowNodeConfigSetCallSchema>;

/** Replace a flow-template node's config blob (per-user draft). */
export const TemplateNodeConfigSetCallSchema = z.object({
  ...AgentCallEnvelope,
  kind: z.literal("template.node.config.set"),
  templateSlug: z.string().min(1),
  nodeId: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
});
export type TemplateNodeConfigSetCall = z.infer<typeof TemplateNodeConfigSetCallSchema>;

/** Dispatch a batch of issues to an existing project flow (project-scoped). */
export const KanbanWaveDispatchCallSchema = z.object({
  ...AgentCallEnvelope,
  kind: z.literal("kanban.wave.dispatch"),
  flowSlug: z.string().min(1),
  issueNumbers: z.array(z.number().int()).min(1).max(10),
});
export type KanbanWaveDispatchCall = z.infer<typeof KanbanWaveDispatchCallSchema>;

/** Create a real GitHub sub-issue linked to a parent (project-scoped). */
export const IssueSubissueCreateCallSchema = z.object({
  ...AgentCallEnvelope,
  kind: z.literal("issue.subissue.create"),
  parentIssueNumber: z.number().int(),
  title: z.string().min(1),
  bodyMd: z.string(),
  labels: z.array(z.string()).optional(),
});
export type IssueSubissueCreateCall = z.infer<typeof IssueSubissueCreateCallSchema>;

export const AgentCallSchema = z.discriminatedUnion("kind", [
  IssueBodySetCallSchema,
  FlowNodeConfigSetCallSchema,
  TemplateNodeConfigSetCallSchema,
  KanbanWaveDispatchCallSchema,
  IssueSubissueCreateCallSchema,
]);
export type AgentCall = z.infer<typeof AgentCallSchema>;

/**
 * Device → server: ACP-mode tool-call request. Same payload as
 * `AgentCall` above but with `agent-call-request` discriminator —
 * the device awaits an `agent-call-result` keyed by the same
 * `callId`. Introduced in #28 alongside the MCP tool surface; the
 * legacy fire-and-forget `agent-call` variant was removed in #30.
 */
const AgentCallRequestEnvelope = {
  type: z.literal("agent-call-request"),
  runId: z.string(),
  callId: z.string(),
};

export const IssueBodySetCallRequestSchema = z.object({
  ...AgentCallRequestEnvelope,
  kind: z.literal("issue.body.set"),
  issueNumber: z.number().int(),
  bodyMd: z.string(),
});

export const FlowNodeConfigSetCallRequestSchema = z.object({
  ...AgentCallRequestEnvelope,
  kind: z.literal("flow.node.config.set"),
  flowSlug: z.string().min(1),
  nodeId: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
});

export const TemplateNodeConfigSetCallRequestSchema = z.object({
  ...AgentCallRequestEnvelope,
  kind: z.literal("template.node.config.set"),
  templateSlug: z.string().min(1),
  nodeId: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
});

export const KanbanWaveDispatchCallRequestSchema = z.object({
  ...AgentCallRequestEnvelope,
  kind: z.literal("kanban.wave.dispatch"),
  flowSlug: z.string().min(1),
  issueNumbers: z.array(z.number().int()).min(1).max(10),
});

export const IssueSubissueCreateCallRequestSchema = z.object({
  ...AgentCallRequestEnvelope,
  kind: z.literal("issue.subissue.create"),
  parentIssueNumber: z.number().int(),
  title: z.string().min(1),
  bodyMd: z.string(),
  labels: z.array(z.string()).optional(),
});

export const AgentCallRequestSchema = z.discriminatedUnion("kind", [
  IssueBodySetCallRequestSchema,
  FlowNodeConfigSetCallRequestSchema,
  TemplateNodeConfigSetCallRequestSchema,
  KanbanWaveDispatchCallRequestSchema,
  IssueSubissueCreateCallRequestSchema,
]);
export type AgentCallRequest = z.infer<typeof AgentCallRequestSchema>;

/**
 * Server → device: response to a prior `agent-call-request`, correlated by
 * `callId`. Either the mutation applied (`ok: true`) or it was rejected
 * (scope check, validation, missing resource — `ok: false`). The device
 * forwards this to the MCP server, which in turn returns it as the tool
 * result to the agent.
 */
export const AgentCallResultSchema = z.object({
  type: z.literal("agent-call-result"),
  runId: z.string(),
  callId: z.string(),
  result: z.union([
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), reason: z.string() }),
  ]),
});
export type AgentCallResultMessage = z.infer<typeof AgentCallResultSchema>;

export const ServerToDeviceMessageSchema = z.discriminatedUnion("type", [
  JobAssignmentSchema,
  HelloAckSchema,
  PingSchema,
  AgentCallResultSchema,
]);
export type ServerToDeviceMessage = z.infer<typeof ServerToDeviceMessageSchema>;

// Nested discriminated unions can't be inlined into another
// discriminatedUnion() (zod requires each option to be a ZodObject with a
// literal discriminator). z.union still discriminates correctly at runtime;
// the only loss is slightly less precise error messages on a malformed
// agent-call envelope.
// `AgentCallSchema` (the legacy fire-and-forget `agent-call` variant)
// was removed from the wire protocol in the #30 cutover — only the
// ACP request/response pair survives. The schema itself is still
// exported above because it's the input shape for `applyAgentCall`
// in the orchestrator's `agent-calls/`.
export const DeviceToServerMessageSchema = z.union([
  HelloMessageSchema,
  LogFrameSchema,
  RunDoneSchema,
  PongSchema,
  AgentCallRequestSchema,
]);
export type DeviceToServerMessage = z.infer<typeof DeviceToServerMessageSchema>;

// ─── Legacy aliases (kept for backwards-compat in shared exports) ───

export const HostRegisterRequestSchema = z.object({
  hostId: z.string(),
  hostName: z.string(),
  capabilities: z.array(z.string()).default([]),
  token: z.string(),
});
export type HostRegisterRequest = z.infer<typeof HostRegisterRequestSchema>;

export const HostRegisterResponseSchema = z.object({
  ok: z.literal(true),
  pollIntervalMs: z.number().int().positive(),
});
export type HostRegisterResponse = z.infer<typeof HostRegisterResponseSchema>;
