import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { DevicePool, WebSocketDispatcher } from "./dispatch/devices.js";
import { createGithubAppClient } from "./github/app.js";
import { GithubOAuth } from "./github/oauth.js";
import { TokenCipher } from "./auth/session.js";
import { currentUser, type AuthEnv } from "./auth/middleware.js";
import { appWebhookRoutes } from "./routes/webhooks.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/api/projects.js";
import { installationRoutes } from "./routes/api/installations.js";
import { activityRoutes } from "./routes/api/activity.js";
import { flowRoutes } from "./routes/api/flows.js";
import { runRoutes } from "./routes/api/runs.js";
import { deviceRoutes } from "./routes/api/devices.js";
import { promptRoutes } from "./routes/api/prompts.js";
import { agentRoutes } from "./routes/api/agents.js";
import { chatRoutes } from "./routes/api/chat.js";
import { chatSessionsRoutes } from "./routes/api/chatSessions.js";
import { flowTemplateRoutes } from "./routes/api/flowTemplates.js";
import { kanbanRoutes } from "./routes/api/kanban.js";
import { pmRoutes } from "./routes/api/pm.js";
import { deviceWsHandler } from "./routes/api/devices/ws.js";
import { mountStatic } from "./static.js";
import { FlowEngine } from "./flows/engine.js";
import { seedBuiltinFlowsForAllProjects } from "./flows/builtin.js";
import { reapOrphanedRuns } from "./flows/reaper.js";

const config = loadConfig();
const { db, pg } = createDb(config.DATABASE_URL);

// Drizzle tracks applied migrations in __drizzle_migrations, so this is a
// no-op once the schema is current. Running it on every boot guarantees a
// restart can never serve against a stale schema — the failure mode that
// took kanban down when migration 0029 shipped without an explicit
// db:migrate step. Failure is intentionally fatal: better a loud crash
// than 500s on routes that touch the new column.
await migrate(db, {
  migrationsFolder: path.resolve(import.meta.dirname, "..", "drizzle"),
});
console.log("[orchestrator] migrations up to date");

const devicePool = new DevicePool(db);
const dispatcher = new WebSocketDispatcher(devicePool);

const app = new Hono<AuthEnv>();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

app.use("*", currentUser(db, config.SESSION_COOKIE_NAME));

app.get("/health", (c) => c.json({ ok: true }));

const githubApp = config.github
  ? createGithubAppClient(config.github, config.GITHUB_WEBHOOK_SECRET)
  : null;

const flowEngine = githubApp
  ? new FlowEngine({ db, pg, app: githubApp, dispatcher, publicBaseUrl: config.PUBLIC_BASE_URL })
  : null;

// Wire flowEngine and githubApp into the device pool after construction
// to break the circular dependency (pool → engine, engine → dispatcher → pool).
if (flowEngine) devicePool.setFlowEngine(flowEngine);
if (githubApp) devicePool.setGithubApp(githubApp);

if (githubApp) {
  app.route(
    "/webhooks/github",
    appWebhookRoutes({
      db,
      pg,
      app: githubApp,
      dispatcher,
      flowEngine: flowEngine ?? undefined,
    }),
  );
  console.log("[orchestrator] GitHub App webhook handler mounted at /webhooks/github");
} else {
  console.log(
    "[orchestrator] GitHub App not configured; webhook handler disabled. Set GITHUB_APP_* and SESSION_ENCRYPTION_KEY to enable.",
  );
}

// Any flow_run / flow_run_step / agent_run still in a non-terminal state at
// boot is orphaned — its owning Promise died with the previous process (tsx
// watch reload, crash, deploy). Without this sweep they stay "running"
// forever and the UI never resolves them.
reapOrphanedRuns(db)
  .then((n) => {
    if (n.agentRuns + n.steps + n.flowRuns > 0) {
      console.log(
        `[orchestrator] reaped orphaned runs: ${n.flowRuns} flow_run(s), ${n.steps} step(s), ${n.agentRuns} agent_run(s)`,
      );
    }
  })
  .catch((err: unknown) => console.error("[orchestrator] reap failed", err));

if (flowEngine) {
  seedBuiltinFlowsForAllProjects(db)
    .then(() => console.log("[orchestrator] flow engine ready (built-in flows seeded)"))
    .catch((err: unknown) => console.error("[orchestrator] flow seeding failed", err));
}

if (config.github && config.SESSION_ENCRYPTION_KEY) {
  const oauth = new GithubOAuth({
    clientId: config.github.clientId,
    clientSecret: config.github.clientSecret,
    publicBaseUrl: config.PUBLIC_BASE_URL,
  });
  const cipher = new TokenCipher(config.SESSION_ENCRYPTION_KEY);

  app.route(
    "/",
    authRoutes({
      db,
      oauth,
      cipher,
      cookieName: config.SESSION_COOKIE_NAME,
      ttlDays: config.SESSION_TTL_DAYS,
      publicBaseUrl: config.PUBLIC_BASE_URL,
      app: githubApp ?? undefined,
    }),
  );
  app.route("/api/projects", projectRoutes({ db, app: githubApp ?? undefined }));
  app.route("/api/installations", installationRoutes({ db, app: githubApp ?? undefined }));
  app.route("/api/activity", activityRoutes({ db }));
  // Hono's app.route(prefix, subapp) only honours the FIRST mount at a given
  // prefix — subsequent app.route("/api", ...) calls are silently dropped.
  // Combine the /api sub-routers into one before mounting once.
  const apiHono = new Hono<AuthEnv>();
  apiHono.route("/", flowRoutes({ db, pg, flowEngine: flowEngine ?? undefined }));
  apiHono.route("/", runRoutes({ db, pg }));
  apiHono.route("/", promptRoutes({ db }));
  apiHono.route("/", agentRoutes({ db, pg, dispatcher }));
  apiHono.route("/", chatRoutes({ db, pg, dispatcher, app: githubApp ?? undefined, publicBaseUrl: config.PUBLIC_BASE_URL }));
  apiHono.route("/", chatSessionsRoutes({ db }));
  apiHono.route("/", flowTemplateRoutes({ db }));
  apiHono.route(
    "/",
    kanbanRoutes({ db, pg, app: githubApp ?? undefined, cipher, oauth }),
  );
  apiHono.route("/", pmRoutes({ db, flowEngine: flowEngine ?? undefined }));
  app.route("/api", apiHono);
  // WS endpoint registered on the root app so @hono/node-ws can attach the
  // upgrade handler to the same Node HTTP server. Must be BEFORE the
  // deviceRoutes mount at the same path prefix to avoid a 404 from the
  // sub-router's miss-handling.
  app.get("/api/devices/ws", upgradeWebSocket(deviceWsHandler({ db, pool: devicePool })));
  app.route("/api/devices", deviceRoutes({ db, cipher, pool: devicePool }));
  console.log("[orchestrator] auth + API routes mounted (WS at /api/devices/ws)");
} else {
  console.log(
    "[orchestrator] auth/API not mounted (need GitHub App config + SESSION_ENCRYPTION_KEY)",
  );
}

// Static SPA serving — must be mounted last so /api, /auth, /webhooks win.
mountStatic(app);

const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
  console.log(`[orchestrator] listening on :${port}`);
});
injectWebSocket(server);
