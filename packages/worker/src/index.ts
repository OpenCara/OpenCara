import { authenticateRequest, hashApiKey } from './auth.js';
import { createSupabaseClient } from './db.js';
import type { Env } from './env.js';
import { handleListAgents, handleCreateAgent } from './handlers/agents.js';
import { handleCollectRatings } from './handlers/collect-ratings.js';
import { handleGetConsumption } from './handlers/consumption.js';
import {
  addCorsHeaders,
  addSecurityHeaders,
  handleCorsPreflightRequest,
} from './handlers/cors.js';
import { handleDeviceFlow, handleDeviceToken, handleRevokeKey } from './handlers/device-flow.js';
import { handleGetStats, handleGetLeaderboard } from './handlers/stats.js';
import { handleWebLogin, handleWebCallback, handleWebLogout } from './handlers/web-auth.js';
import { handleGitHubWebhook } from './webhook.js';

export { AgentConnection } from './agent-connection.js';
export { TaskTimeout } from './task-timeout.js';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // CORS preflight for /api/* routes
    if (method === 'OPTIONS' && pathname.startsWith('/api/')) {
      return addSecurityHeaders(handleCorsPreflightRequest(request, env));
    }

    // Webhook endpoint (public, validated by signature)
    if (method === 'POST' && pathname === '/webhook/github') {
      return addSecurityHeaders(await handleGitHubWebhook(request, env));
    }

    // WebSocket connection for agents
    if (pathname.startsWith('/ws/agent/')) {
      return handleAgentWebSocket(request, url, env);
    }

    const supabase = createSupabaseClient(env);

    // Web OAuth endpoints (public)
    if (method === 'GET' && pathname === '/auth/login') {
      return addSecurityHeaders(await handleWebLogin(request, env));
    }
    if (method === 'GET' && pathname === '/auth/callback') {
      return addSecurityHeaders(await handleWebCallback(request, env, supabase));
    }
    if (method === 'GET' && pathname === '/auth/logout') {
      return addSecurityHeaders(await handleWebLogout(request, env));
    }

    // Device flow auth endpoints (public)
    if (method === 'POST' && pathname === '/auth/device') {
      return addSecurityHeaders(await handleDeviceFlow(env));
    }
    if (method === 'POST' && pathname === '/auth/device/token') {
      return addSecurityHeaders(await handleDeviceToken(request, env, supabase));
    }

    // Auth endpoints (authenticated)
    if (method === 'POST' && pathname === '/auth/revoke') {
      const user = await authenticateRequest(request, supabase);
      if (!user) {
        return addSecurityHeaders(json({ error: 'Unauthorized' }, 401));
      }
      return addSecurityHeaders(await handleRevokeKey(user, supabase));
    }

    // --- API routes (with CORS) ---
    const response = await handleApiRoutes(request, method, pathname, env, supabase);
    if (response) {
      return addSecurityHeaders(addCorsHeaders(request, response, env));
    }

    return addSecurityHeaders(json({ error: 'Not found' }, 404));
  },
} satisfies ExportedHandler<Env>;

/** Route /api/* endpoints. Returns null if no route matches. */
async function handleApiRoutes(
  request: Request,
  method: string,
  pathname: string,
  env: Env,
  supabase: ReturnType<typeof createSupabaseClient>,
): Promise<Response | null> {
  // Agent endpoints (authenticated)
  if (pathname === '/api/agents') {
    const user = await authenticateRequest(request, supabase);
    if (!user) {
      return json({ error: 'Unauthorized' }, 401);
    }
    if (method === 'GET') {
      return handleListAgents(user, supabase);
    }
    if (method === 'POST') {
      return handleCreateAgent(request, user, supabase);
    }
  }

  // Stats endpoint (authenticated)
  const statsMatch = pathname.match(/^\/api\/stats\/([^/]+)$/);
  if (method === 'GET' && statsMatch) {
    const user = await authenticateRequest(request, supabase);
    if (!user) {
      return json({ error: 'Unauthorized' }, 401);
    }
    return handleGetStats(statsMatch[1], user, supabase);
  }

  // Leaderboard endpoint (public)
  if (method === 'GET' && pathname === '/api/leaderboard') {
    return handleGetLeaderboard(supabase);
  }

  // Collect ratings endpoint (authenticated)
  const collectRatingsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/collect-ratings$/);
  if (method === 'POST' && collectRatingsMatch) {
    const user = await authenticateRequest(request, supabase);
    if (!user) {
      return json({ error: 'Unauthorized' }, 401);
    }
    return handleCollectRatings(collectRatingsMatch[1], user, env, supabase);
  }

  // Consumption stats endpoint (authenticated)
  const consumptionMatch = pathname.match(/^\/api\/consumption\/([a-f0-9-]+)$/);
  if (method === 'GET' && consumptionMatch) {
    const user = await authenticateRequest(request, supabase);
    if (!user) {
      return json({ error: 'Unauthorized' }, 401);
    }
    return handleGetConsumption(consumptionMatch[1], user, supabase);
  }

  return null;
}

/**
 * Authenticate and forward agent WebSocket connection to the DO.
 * URL format: /ws/agent/{agentId}?token={apiKey}
 */
async function handleAgentWebSocket(request: Request, url: URL, env: Env): Promise<Response> {
  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return json({ error: 'Expected WebSocket' }, 426);
  }

  const agentId = url.pathname.split('/')[3];
  const token = url.searchParams.get('token');

  if (!agentId || !token) {
    return json({ error: 'Missing agentId or token' }, 400);
  }

  // Authenticate the token
  const supabase = createSupabaseClient(env);
  const keyHash = await hashApiKey(token);
  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('api_key_hash', keyHash)
    .single();

  if (!user) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // Verify agent belongs to this user
  const { data: agent } = await supabase
    .from('agents')
    .select('id')
    .eq('id', agentId)
    .eq('user_id', user.id)
    .single();

  if (!agent) {
    return json({ error: 'Agent not found' }, 404);
  }

  // Forward to Durable Object
  const doId = env.AGENT_CONNECTION.idFromName(agentId);
  const stub = env.AGENT_CONNECTION.get(doId);
  return stub.fetch(
    new Request(`https://internal/websocket?agentId=${agentId}`, {
      headers: request.headers,
    }),
  );
}
