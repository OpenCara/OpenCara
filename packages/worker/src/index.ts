import { authenticateRequest } from './auth.js';
import { createSupabaseClient } from './db.js';
import type { Env } from './env.js';
import { handleListAgents, handleCreateAgent } from './handlers/agents.js';
import {
  handleDeviceFlow,
  handleDeviceToken,
  handleRevokeKey,
} from './handlers/device-flow.js';
import { handleGitHubWebhook } from './webhook.js';

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

    return json({ error: 'Not found' }, 404);
  },
} satisfies ExportedHandler<Env>;
