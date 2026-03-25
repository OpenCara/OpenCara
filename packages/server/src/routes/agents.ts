import { Hono } from 'hono';
import type { AgentStatus, AgentActivity, AgentsResponse } from '@opencara/shared';
import type { Env, AppVariables } from '../types.js';
import { requireApiKey } from '../middleware/auth.js';
import { apiError } from '../errors.js';

/** Thresholds for agent status classification (milliseconds). */
const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_ACTIVE_SINCE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Determine agent status from last-seen timestamp. */
export function agentStatus(lastSeen: number, now: number): AgentStatus {
  const age = now - lastSeen;
  if (age <= ACTIVE_THRESHOLD_MS) return 'active';
  if (age <= IDLE_THRESHOLD_MS) return 'idle';
  return 'offline';
}

export function agentRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  // API key auth — skips when API_KEYS is not configured (open mode)
  app.use('/api/agents', requireApiKey());

  /** GET /api/agents — list agents with status and claim stats */
  app.get('/api/agents', async (c) => {
    const store = c.get('store');
    const now = Date.now();

    // Parse optional active_since query param
    const activeSinceParam = c.req.query('active_since');
    let sinceMs: number;

    if (activeSinceParam !== undefined) {
      const parsed = Number(activeSinceParam);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return apiError(c, 400, 'INVALID_REQUEST', 'active_since must be a non-negative number');
      }
      sinceMs = parsed;
    } else {
      sinceMs = now - DEFAULT_ACTIVE_SINCE_MS;
    }

    const heartbeats = await store.listAgentHeartbeats(sinceMs);
    const agentIds = heartbeats.map((hb) => hb.agent_id);
    const statsMap = await store.getAgentClaimStatsBatch(agentIds);

    const emptyStats = { total: 0, completed: 0, rejected: 0, error: 0, pending: 0 };
    const agents: AgentActivity[] = heartbeats.map((hb) => ({
      agent_id: hb.agent_id,
      last_seen: hb.last_seen,
      status: agentStatus(hb.last_seen, now),
      claims: statsMap.get(hb.agent_id) ?? { ...emptyStats },
    }));

    return c.json<AgentsResponse>({ agents });
  });

  return app;
}
