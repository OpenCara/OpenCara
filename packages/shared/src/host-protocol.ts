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

export const ServerToDeviceMessageSchema = z.discriminatedUnion("type", [
  JobAssignmentSchema,
  HelloAckSchema,
  PingSchema,
]);
export type ServerToDeviceMessage = z.infer<typeof ServerToDeviceMessageSchema>;

export const DeviceToServerMessageSchema = z.discriminatedUnion("type", [
  HelloMessageSchema,
  LogFrameSchema,
  RunDoneSchema,
  PongSchema,
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
