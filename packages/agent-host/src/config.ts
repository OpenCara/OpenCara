import { z } from "zod";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

const ConfigSchema = z.object({
  ORCHESTRATOR_URL: z.string().url(),
  AGENT_HOST_TOKEN: z.string().min(1),
  HOST_ID: z.string().min(1),
  HOST_NAME: z.string().min(1),
});

export type HostConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): HostConfig {
  return ConfigSchema.parse({
    ORCHESTRATOR_URL: process.env["ORCHESTRATOR_URL"] ?? "http://localhost:3000",
    AGENT_HOST_TOKEN: process.env["AGENT_HOST_TOKEN"] ?? "changeme",
    HOST_ID: process.env["HOST_ID"] ?? randomUUID(),
    HOST_NAME: process.env["HOST_NAME"] ?? hostname(),
  });
}
