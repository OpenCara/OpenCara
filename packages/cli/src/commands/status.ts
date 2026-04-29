import { readConfig } from "../config/store.js";

export async function status(): Promise<void> {
  const cfg = readConfig();
  if (!cfg) {
    console.log("Not paired. Run 'opencara' to pair and start accepting jobs.");
    return;
  }
  console.log(`Paired:`);
  console.log(`  Device: ${cfg.deviceName}`);
  console.log(`  Host ID: ${cfg.agentHostId}`);
  console.log(`  Server: ${cfg.orchestratorUrl}`);
}
