import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";

interface GithubRouteDeps {
  webhookSecret: string;
  onEvent: (event: { id: string; type: string; payload: unknown }) => Promise<void>;
}

export function githubRoutes(deps: GithubRouteDeps) {
  const app = new Hono();

  app.post("/webhooks/github", async (c) => {
    const signature = c.req.header("x-hub-signature-256");
    const eventType = c.req.header("x-github-event") ?? "unknown";
    const deliveryId = c.req.header("x-github-delivery") ?? randomUUID();
    const raw = await c.req.text();

    if (!verifySignature(deps.webhookSecret, raw, signature)) {
      return c.json({ error: "invalid signature" }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    await deps.onEvent({ id: deliveryId, type: eventType, payload });
    return c.json({ ok: true });
  });

  return app;
}

function verifySignature(secret: string, body: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
