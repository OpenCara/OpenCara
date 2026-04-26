import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { LocalSubprocessDispatcher } from "./dispatch/local.js";
import { DevicePool, WebSocketDispatcher } from "./dispatch/devices.js";
import { DispatcherRouter } from "./dispatch/router.js";
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
import { deviceWsHandler } from "./routes/api/devices/ws.js";
import { mountStatic } from "./static.js";
import { FlowEngine } from "./flows/engine.js";
import { seedBuiltinFlowsForAllProjects } from "./flows/builtin.js";

const config = loadConfig();
const { db, pg } = createDb(config.DATABASE_URL);

const localDispatcher = new LocalSubprocessDispatcher({ defaultCwd: process.cwd() });
const devicePool = new DevicePool(db);
const wsDispatcher = new WebSocketDispatcher(devicePool);
const dispatcher = new DispatcherRouter(localDispatcher, wsDispatcher, devicePool);

const app = new Hono<AuthEnv>();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

app.use("*", currentUser(db, config.SESSION_COOKIE_NAME));

app.get("/health", (c) => c.json({ ok: true }));

const githubApp = config.github
  ? createGithubAppClient(config.github, config.GITHUB_WEBHOOK_SECRET)
  : null;

const flowEngine = githubApp
  ? new FlowEngine({ db, pg, app: githubApp, dispatcher })
  : null;

if (githubApp) {
  app.route(
    "/webhooks/github",
    appWebhookRoutes({ db, app: githubApp, flowEngine: flowEngine ?? undefined }),
  );
  console.log("[orchestrator] GitHub App webhook handler mounted at /webhooks/github");
} else {
  console.log(
    "[orchestrator] GitHub App not configured; webhook handler disabled. Set GITHUB_APP_* and SESSION_ENCRYPTION_KEY to enable.",
  );
}

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
  app.route("/api/projects", projectRoutes({ db }));
  app.route("/api/installations", installationRoutes({ db, app: githubApp ?? undefined }));
  app.route("/api/activity", activityRoutes({ db }));
  // Hono's app.route(prefix, subapp) only honours the FIRST mount at a given
  // prefix — subsequent app.route("/api", ...) calls are silently dropped.
  // Combine the /api sub-routers into one before mounting once.
  const apiHono = new Hono<AuthEnv>();
  apiHono.route("/", flowRoutes({ db }));
  apiHono.route("/", runRoutes({ db, pg }));
  apiHono.route("/", promptRoutes({ db }));
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
