import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { platformEvents } from "./db/schema.js";
import { githubRoutes } from "./routes/github.js";
import { LocalSubprocessDispatcher } from "./dispatch/local.js";

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const dispatcher = new LocalSubprocessDispatcher();

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.route(
  "/",
  githubRoutes({
    webhookSecret: config.GITHUB_WEBHOOK_SECRET,
    onEvent: async (event) => {
      await db.insert(platformEvents).values({
        id: event.id,
        platform: "github",
        type: event.type,
        payload: event.payload as object,
      });
      // TODO: route event through rules → dispatcher
      void dispatcher;
    },
  }),
);

serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
  console.log(`[orchestrator] listening on :${port}`);
});
