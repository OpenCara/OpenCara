import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  PairingCreateResponseSchema,
  PairingStatusResponseSchema,
} from "@openkira/shared";
import { defaultOrchestratorUrl, readConfig, writeConfig } from "../config/store.js";

interface RegisterOpts {
  url?: string;
  force?: boolean;
}

const POLL_INTERVAL_MS = 2000;

export async function register(opts: RegisterOpts = {}): Promise<void> {
  const orchestratorUrl = opts.url ?? defaultOrchestratorUrl();
  if (!opts.force && readConfig()) {
    console.log("Already paired. Use --force to re-pair.");
    return;
  }

  const deviceSecret = randomBytes(32).toString("base64url");
  const deviceSecretHash = createHash("sha256").update(deviceSecret).digest("hex");

  const createRes = await fetch(`${orchestratorUrl}/api/devices/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "fetch" },
    body: JSON.stringify({ device_secret_hash: deviceSecretHash }),
  });
  if (!createRes.ok) {
    throw new Error(`pairing create failed: ${createRes.status} ${await createRes.text()}`);
  }
  const { code, expires_at } = PairingCreateResponseSchema.parse(await createRes.json());

  const pairUrl = `${orchestratorUrl}/devices/pair?code=${encodeURIComponent(code)}`;
  console.log(`\n  Pairing code: ${code}`);
  console.log(`  Open ${pairUrl} in your browser to confirm.`);
  console.log(`  Expires at ${expires_at}.\n`);
  openBrowser(pairUrl);

  const expiry = new Date(expires_at).getTime();
  while (Date.now() < expiry) {
    await sleep(POLL_INTERVAL_MS);
    const statusRes = await fetch(
      `${orchestratorUrl}/api/devices/pairings/${encodeURIComponent(code)}/status?secret=${deviceSecret}`,
    );
    if (!statusRes.ok) {
      console.error(`  status check failed: ${statusRes.status}`);
      continue;
    }
    const result = PairingStatusResponseSchema.parse(await statusRes.json());
    if (result.status === "pending") {
      process.stdout.write(".");
      continue;
    }
    if (result.status === "expired") {
      throw new Error("pairing expired before confirmation");
    }
    writeConfig({
      orchestratorUrl,
      token: result.token,
      agentHostId: result.agent_host_id,
      deviceName: result.device_name,
    });
    console.log(`\n\n  ✓ Paired as "${result.device_name}".`);
    console.log(`  Run 'openkira run' to start accepting jobs.`);
    return;
  }
  throw new Error("pairing timed out");
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // best effort
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
