import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { z } from "zod";
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_ORCHESTRATOR_URL } from "./paths.js";

const ConfigSchema = z.object({
  orchestratorUrl: z.string().url(),
  token: z.string(),
  agentHostId: z.string(),
  deviceName: z.string(),
});
export type Config = z.infer<typeof ConfigSchema>;

export function readConfig(): Config | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return ConfigSchema.parse(JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
  } catch {
    return null;
  }
}

export function writeConfig(cfg: Config): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function clearConfig(): void {
  if (existsSync(CONFIG_FILE)) unlinkSync(CONFIG_FILE);
}

export function defaultOrchestratorUrl(): string {
  return process.env["OPENKIRA_URL"] ?? DEFAULT_ORCHESTRATOR_URL;
}
