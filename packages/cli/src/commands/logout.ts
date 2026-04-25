import { clearConfig, readConfig } from "../config/store.js";

export async function logout(): Promise<void> {
  const cfg = readConfig();
  if (!cfg) {
    console.log("Not paired.");
    return;
  }
  try {
    const res = await fetch(
      `${cfg.orchestratorUrl}/api/devices/${cfg.agentHostId}/revoke`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.token}`,
          "x-requested-with": "fetch",
        },
      },
    );
    if (!res.ok) {
      console.warn(`server revoke responded ${res.status}; clearing local config anyway`);
    }
  } catch (err) {
    console.warn(`server revoke failed: ${(err as Error).message}; clearing local config anyway`);
  }
  clearConfig();
  console.log("Removed local credentials.");
}
