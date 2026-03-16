import { authenticateRequest, hashApiKey } from './auth.js';
import { createSupabaseClient } from './db.js';
import type { Env } from './env.js';
import { handleListAgents, handleCreateAgent } from './handlers/agents.js';
import { handleGetConsumption } from './handlers/consumption.js';
import { handleDeviceFlow, handleDeviceToken, handleRevokeKey } from './handlers/device-flow.js';
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

    // Webhook endpoint (public, validated by signature)
    if (method === 'POST' && pathname === '/webhook/github') {
      return handleGitHubWebhook(request, env);
    }

    // WebSocket connection for agents
    if (pathname.startsWith('/ws/agent/')) {
      return handleAgentWebSocket(request, url, env);
    }

    const supabase = createSupabaseClient(env);

    // Auth endpoints (public)
    if (method === 'POST' && pathname === '/auth/device') {
      return handleDeviceFlow(env);
    }
    if (method === 'POST' && pathname === '/auth/device/token') {
      return handleDeviceToken(request, env, supabase);
    }

    // Auth endpoints (authenticated)
    if (method === 'POST' && pathname === '/auth/revoke') {
      const user = await authenticateRequest(request, supabase);
      if (!user) {
        return json({ error: 'Unauthorized' }, 401);
      }
      return handleRevokeKey(user, supabase);
    }

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

    // Consumption stats endpoint (authenticated)
    const consumptionMatch = pathname.match(/^\/api\/consumption\/([a-f0-9-]+)$/);
    if (method === 'GET' && consumptionMatch) {
      const user = await authenticateRequest(request, supabase);
      if (!user) {
        return json({ error: 'Unauthorized' }, 401);
      }
      return handleGetConsumption(consumptionMatch[1], user, supabase);
    }

    return json({ error: 'Not found' }, 404);
  },
} satisfies ExportedHandler<Env>;

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
