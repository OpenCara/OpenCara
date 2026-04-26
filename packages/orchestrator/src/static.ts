import type { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthEnv } from "./auth/middleware.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function mountStatic(app: Hono<AuthEnv>): boolean {
  const candidates = [
    resolve(__dirname, "../../../apps/web/dist"),
    resolve(__dirname, "../../apps/web/dist"),
  ];
  const root = candidates.find((p) => existsSync(p));
  if (!root) {
    return false;
  }

  app.use(
    "/*",
    serveStatic({
      root: relativeToCwd(root),
      onFound: (_path, c) => {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  );

  const indexPath = resolve(root, "index.html");
  // Server-rendered paths must NOT be swallowed by the SPA fallback —
  // otherwise /api/* misses look like 200 HTML to the browser, which then
  // tries to JSON.parse the SPA shell and explodes.
  app.get("/*", (c) => {
    const p = c.req.path;
    if (p.startsWith("/api/") || p.startsWith("/auth/") || p.startsWith("/webhooks/")) {
      return c.json({ error: "not found" }, 404);
    }
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return c.body(readFileSync(indexPath, "utf8"));
  });

  console.log(`[orchestrator] static SPA mounted from ${root}`);
  return true;
}

function relativeToCwd(abs: string): string {
  const cwd = process.cwd();
  if (abs.startsWith(cwd + "/")) return "./" + abs.slice(cwd.length + 1);
  return abs;
}
