# OpenCara Performance Report — June 2026

> **Issue:** #171  
> **Previous analysis:** #150 (completed June 4 2026, PR #151)  
> **Date:** 2026-06-24

---

## Executive Summary

Issue #150 shipped a large batch of high-ROI fixes: route-level code splitting,
adaptive polling, single-join project lookups, and DB pool hardening. The site
is materially faster today than it was before those changes. This report profiles
what remains and identifies the next tier of improvements.

---

## 1. Baseline Metrics (Methodology)

Direct Web-Vitals measurement requires a browser session against the live site.
The recommended tooling:

```
# Lighthouse CLI (automated, repeatable)
npx lighthouse https://opencara.com --output json --throttling-method=devtools

# WebPageTest (third-party, multi-location)
https://www.webpagetest.org/ → Enter URL, choose "Desktop" + "Cloudflare CDN"

# Chrome DevTools
  DevTools → Lighthouse → Performance → run 3× and average
  DevTools → Performance panel → record page load, look for LCP marker

# Google PageSpeed Insights (uses CrUX field data)
https://pagespeed.web.dev/
```

**Target thresholds (Core Web Vitals "Good" band):**

| Metric | Good | Needs Improvement | Poor |
|--------|------|-------------------|------|
| LCP | ≤ 2.5 s | 2.5 – 4.0 s | > 4.0 s |
| INP | ≤ 200 ms | 200 – 500 ms | > 500 ms |
| CLS | ≤ 0.1 | 0.1 – 0.25 | > 0.25 |
| TTFB | ≤ 800 ms | 800 – 1800 ms | > 1800 ms |

**Pages to measure:**

| Page | Route | Expected bottleneck |
|------|-------|-------------------|
| Landing / Activity | `/` | Initial bundle parse |
| Project Kanban | `/projects/:id` | SSE connection + kanban snapshot query |
| Issue editing | `/projects/:id/issues/:number` | Issue body fetch + SSE diff |
| Flow-runs | `/projects/:id/flows/:slug` | Flow runs list query |
| Sessions | `/chat` | Chat session list + first message load |

---

## 2. Issue #150 — Status of Each Recommendation

| # | Recommendation | Status | PR |
|---|---|---|---|
| 1 | Route-level React.lazy() code splitting | ✅ Done | #151 |
| 2 | Lazy-load xyflow / highlight.js / dnd-kit / react-markdown | ✅ Done | #151 |
| 3 | Add rollup-plugin-visualizer for bundle tracking | ❌ Not done | — |
| 4 | pmWavesQuery adaptive polling (tab-hide + idle gate) | ✅ Done | #151 |
| 5 | Single join: project + installation lookup | ✅ Done | #151 |
| 6 | Partial index on flow_runs to avoid seq-scan | ✅ Done | #154 |
| 7 | LIMIT on MCP poison-check log read | ✅ Done | #151 |
| 8 | N+1 in rerun-from-step (buildPreloadedOutputs) | ⚠️ Open | — |
| 9 | DB pool ceiling vs Supabase pooler cap | ✅ Done (max=12) | #154 |

**Net:** 7 of 9 shipped. Items 3 and 8 remain.

---

## 3. Current Bottlenecks

### 3.1 N+1 Queries in `buildPreloadedOutputs` (Cold Path)

**File:** `packages/orchestrator/src/flows/engine.ts:226–244`  
**Severity:** Medium  
**Trigger:** Manual "rerun from step" only; not the hot path.

For each succeeded step, the function issues:
1. `agentRuns.findFirst({ where: flowRunStepId = s.id })`
2. `agentRunLogs` select for that run's stdout

With N steps, that's 2N sequential 61 ms roundtrips. A 10-step flow = 20
queries ≈ 1.2 s before the rerun even starts.

**Fix:**
```ts
// 1. Batch all agent runs in one query
const arRows = await deps.db.query.agentRuns.findMany({
  where: inArray(agentRuns.flowRunStepId, allSteps.map(s => s.id)),
  columns: { id: true, flowRunStepId: true },
});
const arByStepId = new Map(arRows.map(r => [r.flowRunStepId, r.id]));

// 2. Batch all stdout logs in one query
const logRows = await deps.db
  .select({ agentRunId: agentRunLogs.agentRunId, chunk: agentRunLogs.chunk, seq: agentRunLogs.seq })
  .from(agentRunLogs)
  .where(and(
    inArray(agentRunLogs.agentRunId, arRows.map(r => r.id)),
    eq(agentRunLogs.stream, 'stdout'),
  ))
  .orderBy(asc(agentRunLogs.agentRunId), asc(agentRunLogs.seq));
// Group by agentRunId, then join to step
```

This collapses N×2 queries to 2 queries regardless of step count.

---

### 3.2 Correlated Subqueries in `/api/projects` List

**File:** `packages/orchestrator/src/routes/api/projects.ts:54–66`  
**Severity:** Low–Medium (grows with project age, not user count)

The projects list query embeds two correlated subqueries per row:

```sql
lastEventAt:    SELECT MAX(received_at) FROM platform_events WHERE project_id = ?
recentRunsCount: SELECT COUNT(*)::int FROM agent_runs
                 WHERE project_id = ? AND created_at > NOW() - INTERVAL '7 days'
```

With 3 projects, that's 6 additional single-row queries inside the main query.
Each is indexed (`platform_events_project_id_received_at_idx`,
`agent_runs_project_id_created_at_idx`) so they're fast today, but this pattern
scales linearly with project count.

**Fix (if this ever shows up in pg_stat_statements):** materialize both via
a lateral join or move `recentRunsCount` to the client since the data is
available from queries already loaded.

---

### 3.3 Global `staleTime: 5_000` Too Aggressive for Stable Data

**File:** `apps/web/src/main.tsx:12`  
**Severity:** Low

The global React Query `staleTime` of 5 s applies to every query, including
data that almost never changes:

| Query | Actual change frequency | Better staleTime |
|---|---|---|
| `agentsQuery` | Minutes–hours (user edits agents) | 60 s |
| `promptsQuery` | Minutes–hours | 60 s |
| `flowTemplatesQuery` | Releases (weeks) | 5 min |
| `devicesQuery` | Only when a device pairs/unpairs | 30 s |
| `projectsQuery` | Minutes–rarely | 30 s |

With the current 5 s TTL, every tab switch refetches all of these. At 5 s
stale + `refetchOnWindowFocus: false` (already set), the load is modest, but
bumping per-query stale times removes background fetches that the user never
sees.

**Fix:** Add per-query `staleTime` overrides in `queries.ts`:
```ts
export const agentsQuery = () =>
  queryOptions({ ..., staleTime: 60_000 });
```

---

### 3.4 No Bundle Size Tracking

**File:** `apps/web/vite.config.ts`  
**Severity:** Low (engineering hygiene)

No `rollup-plugin-visualizer` means bundle composition can silently regress.
The initial entry JS was ~1,192 KB before #150; after code splitting it became
~418 KB for the entry chunk. There's no automated way to catch a future library
that lands in the entry chunk when it shouldn't.

**Fix:**
```ts
// vite.config.ts
import { visualizer } from "rollup-plugin-visualizer";

plugins: [
  react(),
  tailwindcss(),
  visualizer({ open: false, filename: "dist/stats.html" }),
],
```

Then `open dist/stats.html` after `vite build` to inspect chunk composition.

---

### 3.5 No Pagination on `GET /runs/:id/logs`

**File:** `packages/orchestrator/src/routes/api/runs.ts:45–60`  
**Severity:** Low (affects long-running agents)

The one-shot log snapshot endpoint fetches ALL log rows for an agent run with
no LIMIT. For long-running agents (multi-hour Claude sessions) this can be
thousands of rows / megabytes.

The SSE stream already has a circular buffer (`maxBuffer`), so this only
matters for the initial page load of a completed run.

**Fix:** Add a `?limit=N&since=seq` query param (the `since` param already
exists; the missing piece is a `LIMIT` clause):
```ts
.where(since >= 0 ? and(eq(...), gt(seq, since)) : eq(...))
.orderBy(asc(agentRunLogs.seq))
.limit(Math.min(Number(c.req.query("limit") ?? 2000), 5000));
```

---

### 3.6 No Prefetching on Predictable Navigation

**Severity:** Very Low (micro-optimization)

Users who land on `/projects` almost always navigate into a specific project
within 1–2 seconds. React Router 7 supports `loader` / prefetch, and React
Query supports `queryClient.prefetchQuery()`. Neither is wired up today.

The return is minimal given that project detail pages are already small lazy
chunks and queries cache on first load, but it would eliminate the skeleton
flash on first project visit.

---

## 4. Prioritized Improvement List

| Priority | Item | Estimated Impact | Effort |
|---|---|---|---|
| **P1** | Fix N+1 in `buildPreloadedOutputs` (`engine.ts:226–244`) | Medium — saves 1–2 s on manual reruns with many steps | Small |
| **P2** | Add `rollup-plugin-visualizer` | Engineering hygiene — catches silent bundle regressions | Tiny |
| **P2** | Per-query `staleTime` overrides for stable data | Reduces unnecessary background fetches | Small |
| **P3** | LIMIT on one-shot log endpoint | Prevents memory spike for very long runs | Tiny |
| **P4** | Correlated subquery in projects list | Only matters at scale (>20 projects/user) | Small |
| **P5** | Route prefetching for project navigation | Micro — removes skeleton flash | Medium |

---

## 5. What Is Already Well-Optimized

These areas from #150's "not a problem" list remain correct, plus new wins:

- **Cloudflare CDN:** Assets served with `cf-cache-status: HIT`, brotli-encoded.
- **Cache-Control headers:** Hashed assets → `immutable, max-age=31536000`;
  `index.html` → `no-store`. Correct.
- **Code splitting:** 14 pages as separate Vite chunks; xyflow / highlight.js /
  dnd-kit / react-markdown load only when their page is visited.
- **DB pool:** Hardened — `max=12` (below Supabase's 15-slot ceiling),
  `connect_timeout=10s`, `statement_timeout=30s`, `max_lifetime=30min`.
- **Kanban SSE:** Project-scoped channels + 400 ms debounce prevent query floods.
- **Adaptive polling:** pmWavesQuery polls at 5 s only during active runs,
  30 s when idle, and stops when the tab is hidden.
- **trigger_skip pruning:** Boot-time + daily cleanup prevents flow_runs table
  bloat that used to cause seq-scans on the kanban snapshot query.
- **Activity feed pagination:** `before` cursor + `limit` clamp implemented.
- **Flow runs list:** Limited to 50 rows; trigger_skip rows excluded by default.
