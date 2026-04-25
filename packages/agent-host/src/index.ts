import { loadConfig } from "./config.js";
import type { HostRegisterRequest, HostRegisterResponse } from "@openkira/shared";

const config = loadConfig();

async function register(): Promise<HostRegisterResponse> {
  const body: HostRegisterRequest = {
    hostId: config.HOST_ID,
    hostName: config.HOST_NAME,
    capabilities: [],
    token: config.AGENT_HOST_TOKEN,
  };
  const res = await fetch(`${config.ORCHESTRATOR_URL}/hosts/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`register failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as HostRegisterResponse;
}

async function main(): Promise<void> {
  console.log(`[agent-host] ${config.HOST_NAME} (${config.HOST_ID}) starting`);
  // TODO: implement registration + job poll loop. Stub for now.
  void register;
}

main().catch((err: unknown) => {
  console.error("[agent-host] fatal", err);
  process.exit(1);
});
