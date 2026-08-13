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
import { currentUser, createSessionCache, type AuthEnv } from "./auth/middleware.js";
import { appWebhookRoutes } from "./routes/webhooks.js";
import { authRoutes } from "./routes/auth.js";
import { EntraOAuth } from "./azure/entra.js";
import { azureWebhookRoutes } from "./routes/webhooksAzure.js";
import { azureRoutes } from "./routes/api/azure.js";
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
import { pruneTriggerSkipFlowRuns } from "./flows/prune.js";
import { runSchedulerTick } from "./flows/scheduler.js";

// Resilience backstop. opencara.com runs as a bare `nohup` process with no
// supervisor (no systemd / PM2 / Docker restart policy), so any hard crash
// takes the public site down until a human restarts it. A single async slip
// must never be able to do that. The real failure on 2026-06-07: an unguarded
// async setInterval in an SSE route hit the Supabase pooler's connection
// ceiling (EMAXCONNSESSION); the rejection was unhandled and Node's default
// promoted it to a fatal uncaughtException. Individual hot paths still guard
// themselves (see the SSE routes) — this is defense-in-depth, not a license to
// stop catching errors locally. We log loudly and keep serving: with no
// supervisor, limping on a logged error strictly beats a dead site.
process.on("unhandledRejection", (reason) => {
  console.error("[orchestrator] unhandledRejection (non-fatal):", reason);
});
// Under a supervisor (the container's `restart: unless-stopped` sets
// OPENCARA_SUPERVISED=1 via the Dockerfile) a clean crash-and-restart beats
// limping in unknown state — the original reason for swallowing these was
// precisely that the bare nohup process had no one to restart it. Unsupervised
// boots keep the limp-on behaviour.
const SUPERVISED = process.env["OPENCARA_SUPERVISED"] === "1";
process.on("uncaughtException", (err) => {
  if (SUPERVISED) {
    console.error("[orchestrator] uncaughtException (fatal — supervisor restarts):", err);
    process.exit(1);
  }
  console.error("[orchestrator] uncaughtException (non-fatal):", err);
});

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
const dispatcher = new WebSocketDispatcher(devicePool, config.JOB_TIMEOUT_MS);

const app = new Hono<AuthEnv>();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

// Without an error handler, a throw in any middleware/route falls through to
// Hono's default, which is fine for the body but logs nothing — so a DB stall
// or statement-timeout abort surfaced to the user as a silent failure with no
// server-side trace (OpenCara#146). Log every unhandled error with its route,
// and return a fast JSON 500 instead of leaving the request hanging.
app.onError((err, c) => {
  console.error(
    `[orchestrator] unhandled error on ${c.req.method} ${c.req.path}:`,
    err,
  );
  return c.json({ error: "internal error" }, 500);
});

// One cache shared by the auth middleware (reads) and the logout route (eager
// invalidation) so a logout takes effect immediately instead of after the TTL.
const sessionCache = createSessionCache(db);
app.use("*", currentUser(db, config.SESSION_COOKIE_NAME, sessionCache));

app.get("/health", (c) => c.json({ ok: true }));

const githubApp = config.github
  ? createGithubAppClient(config.github, config.GITHUB_WEBHOOK_SECRET)
  : null;

// Azure DevOps client deps, built once and shared by the flow engine and the
// API routes. Requires SESSION_ENCRYPTION_KEY because connection tokens are
// stored encrypted with the same cipher as session tokens.
const azureDeps =
  config.SESSION_ENCRYPTION_KEY
    ? {
        db,
        cipher: new TokenCipher(config.SESSION_ENCRYPTION_KEY),
        // Present only when an Entra app is configured; PAT connections do not
        // need one.
        entra: config.azureDevops
          ? new EntraOAuth({
              clientId: config.azureDevops.clientId,
              clientSecret: config.azureDevops.clientSecret,
              tenant: config.azureDevops.tenant,
              publicBaseUrl: config.PUBLIC_BASE_URL,
            })
          : undefined,
      }
    : null;

// Built when EITHER platform is configured — an Azure-DevOps-only deployment
// has no GitHub App but still needs an engine to run its flows.
const flowEngine =
  githubApp || azureDeps
    ? new FlowEngine({
        db,
        pg,
        app: githubApp ?? undefined,
        azure: azureDeps ?? undefined,
        dispatcher,
        publicBaseUrl: config.PUBLIC_BASE_URL,
      })
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

// Prune the `trigger_skip` flow_run backlog (webhook fan-out noise) on boot
// and once a day. Left unbounded it grows without limit and bloats every
// flow_id scan the kanban board issues (OpenCara#146). Best-effort: a failure
// here never blocks startup or serving.
const runFlowRunPrune = () => {
  pruneTriggerSkipFlowRuns(db)
    .then((n) => {
      if (n > 0) console.log(`[orchestrator] pruned ${n} trigger_skip flow_run(s)`);
    })
    .catch((err: unknown) => console.error("[orchestrator] flow_run prune failed", err));
};
runFlowRunPrune();
const FLOW_RUN_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// unref so the daily timer never keeps the process alive on its own.
setInterval(runFlowRunPrune, FLOW_RUN_PRUNE_INTERVAL_MS).unref();

// Server-side WS heartbeat: ping every device each tick and reap half-open
// sockets that miss a pong, so a flaky-link reconnect can't leave a dead
// socket registered for pinned dispatch. unref so it never holds the process.
devicePool.startHeartbeat().unref();

if (flowEngine) {
  seedBuiltinFlowsForAllProjects(db)
    .then(() => console.log("[orchestrator] flow engine ready (built-in flows seeded)"))
    .catch((err: unknown) => console.error("[orchestrator] flow seeding failed", err));
}

// Cron scheduler (#128). Polls flow_schedule_state every minute and fires any
// schedule.cron trigger whose next occurrence has passed. Each schedule fires
// at most once per tick: an occurrence that's already due when the tick runs
// is dispatched, then the row jumps to the next occurrence after *now* (not
// the missed one). For hourly-or-coarser schedules that's exactly-once even if
// a tick is delayed; a sub-hourly schedule (e.g. every-minute) can drop an
// occurrence under tick backpressure — acceptable for recurring jobs, but not
// a hard "every slot fires" guarantee. As with the other background jobs:
// best-effort, errors logged not thrown, and the timer is unref'd so it never
// holds the process open on its own.
if (flowEngine) {
  const engine = flowEngine;
  const SCHEDULER_TICK_MS = 60 * 1000;
  const runScheduler = () => {
    runSchedulerTick({ db, engine })
      .then((n) => {
        if (n > 0) console.log(`[orchestrator] scheduler fired ${n} scheduled run(s)`);
      })
      .catch((err: unknown) => console.error("[orchestrator] scheduler tick failed", err));
  };
  runScheduler();
  setInterval(runScheduler, SCHEDULER_TICK_MS).unref();
  console.log("[orchestrator] cron scheduler started (60s tick)");
}

// Auth + the whole /api surface mount when EITHER platform is configured.
// Gating this on `config.github` alone is what made an Azure-DevOps-only
// deployment silently serve nothing but /health: the flow engine started, but
// sign-in, /api/*, and /webhooks/azure-devops never mounted.
// SESSION_ENCRYPTION_KEY is required either way — it encrypts session and
// connection tokens.
if ((config.github || azureDeps) && config.SESSION_ENCRYPTION_KEY) {
  const oauth = config.github
    ? new GithubOAuth({
        clientId: config.github.clientId,
        clientSecret: config.github.clientSecret,
        publicBaseUrl: config.PUBLIC_BASE_URL,
      })
    : undefined;
  // Same key, so azureDeps.cipher (when present) is interchangeable; reuse it
  // rather than holding two instances of the same cipher.
  const cipher = azureDeps?.cipher ?? new TokenCipher(config.SESSION_ENCRYPTION_KEY);

  // Optional second sign-in provider. Absent config leaves /auth/azure/*
  // unmounted and the login page GitHub-only. Reuses the single client built
  // for `azureDeps` above so token refreshes share one instance.
  const entraOAuth = azureDeps?.entra;
  if (entraOAuth) {
    console.log(
      `[orchestrator] Microsoft Entra sign-in enabled (tenant: ${config.azureDevops!.tenant})`,
    );
  }

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
      sessionCache,
      entraOAuth,
    }),
  );
  // Mounted unconditionally: a Personal Access Token connection needs no Entra
  // app at all, and an organization backed by a personal Microsoft account can
  // ONLY be reached that way (Azure DevOps is work/school-only in Entra). The
  // Entra-specific endpoints answer 409 when AZDO_ENTRA_* is unset.
  app.route(
    "/webhooks/azure-devops",
    azureWebhookRoutes({ db, cipher, flowEngine: flowEngine ?? undefined }),
  );
  app.route(
    "/api/azure",
    azureRoutes({
      db,
      cipher,
      entra: entraOAuth,
      publicBaseUrl: config.PUBLIC_BASE_URL,
      cookieName: config.SESSION_COOKIE_NAME,
    }),
  );
  console.log(
    `[orchestrator] Azure DevOps routes mounted (webhooks at /webhooks/azure-devops; Entra sign-in ${entraOAuth ? "enabled" : "disabled — PAT connections only"})`,
  );
  app.route(
    "/api/projects",
    projectRoutes({ db, app: githubApp ?? undefined, azure: azureDeps ?? undefined }),
  );
  // GitHub App installations have no Azure DevOps analogue — the equivalent
  // surface is /api/azure/connections.
  if (config.github) {
    app.route("/api/installations", installationRoutes({ db, app: githubApp ?? undefined }));
  }
  app.route("/api/activity", activityRoutes({ db }));
  // Hono's app.route(prefix, subapp) only honours the FIRST mount at a given
  // prefix — subsequent app.route("/api", ...) calls are silently dropped.
  // Combine the /api sub-routers into one before mounting once.
  const apiHono = new Hono<AuthEnv>();
  apiHono.route("/", flowRoutes({ db, pg, flowEngine: flowEngine ?? undefined, dispatcher }));
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
  apiHono.route("/", pmRoutes({ db, flowEngine: flowEngine ?? undefined, dispatcher }));
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
    "[orchestrator] auth/API not mounted — configure GITHUB_APP_* and/or AZDO_ENTRA_*, plus SESSION_ENCRYPTION_KEY",
  );
}

// Static SPA serving — must be mounted last so /api, /auth, /webhooks win.
mountStatic(app);

const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
  console.log(`[orchestrator] listening on :${port}`);
});
injectWebSocket(server);

// Graceful shutdown. Deploys send SIGTERM (docker stop / kill -TERM): stop
// accepting new connections, close device sockets so CLIs reconnect to the
// replacement process, then close the pg pool and exit 0. Open SSE streams
// hold the HTTP server open indefinitely, so a grace timer — not
// server.close() completing — is what actually bounds the drain.
let shuttingDown = false;
const DRAIN_GRACE_MS = 8_000;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[orchestrator] ${signal} received — draining (max ${DRAIN_GRACE_MS}ms)`);
  // Reachable from both server.close()'s callback and the grace timer;
  // guard so pg.end() runs once no matter which fires first.
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    void Promise.resolve(pg.end({ timeout: 5 }))
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  devicePool.closeAll();
  server.close(() => finish());
  // Not unref'd: it must fire even while lingering SSE/WS connections keep
  // the server (and therefore server.close's callback) from completing.
  setTimeout(() => {
    console.log("[orchestrator] drain grace elapsed — exiting with streams open");
    finish();
  }, DRAIN_GRACE_MS);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
