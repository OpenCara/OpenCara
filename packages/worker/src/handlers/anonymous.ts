import type {
  AnonymousRegisterRequest,
  AnonymousRegisterResponse,
  LinkAccountRequest,
  LinkAccountResponse,
  User,
} from '@opencara/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateApiKey, hashApiKey } from '../auth.js';
import type { Env } from '../env.js';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ANON_RATE_LIMIT = 3;
const ANON_RATE_LIMIT_TTL = 86400; // 24 hours in seconds

/**
 * POST /api/agents/anonymous — public, no auth required.
 * Creates a synthetic anonymous user + agent + API key.
 * Rate limited to 3 per IP per 24 hours via KV.
 */
export async function handleAnonymousRegister(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
): Promise<Response> {
  // Parse request body
  let body: AnonymousRegisterRequest;
  try {
    body = (await request.json()) as AnonymousRegisterRequest;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.model || !body.tool) {
    return json({ error: 'model and tool are required' }, 400);
  }

  // Rate limit by IP
  const ip =
    request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For') ?? 'unknown';
  const kvKey = `anon-ip:${ip}`;

  const currentCount = parseInt((await env.RATE_LIMIT_KV.get(kvKey)) ?? '0', 10);
  if (currentCount >= ANON_RATE_LIMIT) {
    return json({ error: 'Rate limit exceeded: max 3 anonymous registrations per 24 hours' }, 429);
  }

  // Generate API key
  const apiKey = await generateApiKey();
  const apiKeyHash = await hashApiKey(apiKey);

  // Create synthetic anonymous user
  const { data: user, error: userError } = await supabase
    .from('users')
    .insert({
      github_id: null,
      name: 'anonymous',
      is_anonymous: true,
      api_key_hash: apiKeyHash,
    })
    .select('id')
    .single();

  if (userError || !user) {
    return json({ error: 'Failed to create anonymous user' }, 500);
  }

  // Create agent
  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .insert({
      user_id: user.id,
      model: body.model,
      tool: body.tool,
      is_anonymous: true,
      ...(body.repoConfig ? { repo_config: body.repoConfig } : {}),
    })
    .select('id')
    .single();

  if (agentError || !agent) {
    return json({ error: 'Failed to create anonymous agent' }, 500);
  }

  // Increment rate limit counter
  await env.RATE_LIMIT_KV.put(kvKey, String(currentCount + 1), {
    expirationTtl: ANON_RATE_LIMIT_TTL,
  });

  return json(
    {
      agentId: agent.id,
      apiKey,
    } satisfies AnonymousRegisterResponse,
    201,
  );
}

/**
 * POST /api/account/link — authenticated.
 * Transfers anonymous agents to the authenticated user's account.
 */
export async function handleLinkAccount(
  request: Request,
  user: User,
  supabase: SupabaseClient,
): Promise<Response> {
  let body: LinkAccountRequest;
  try {
    body = (await request.json()) as LinkAccountRequest;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.anonymousApiKey) {
    return json({ error: 'anonymousApiKey is required' }, 400);
  }

  // Look up the anonymous user by hashing the provided key
  const keyHash = await hashApiKey(body.anonymousApiKey);
  const { data: anonUser, error: lookupError } = await supabase
    .from('users')
    .select('id, is_anonymous')
    .eq('api_key_hash', keyHash)
    .single();

  if (lookupError || !anonUser) {
    return json({ error: 'Invalid anonymous API key' }, 400);
  }

  if (!anonUser.is_anonymous) {
    return json({ error: 'Provided key does not belong to an anonymous user' }, 400);
  }

  // Don't link to yourself
  if (anonUser.id === user.id) {
    return json({ error: 'Cannot link to your own account' }, 400);
  }

  // Find all agents belonging to the anonymous user
  const { data: agents } = await supabase.from('agents').select('id').eq('user_id', anonUser.id);

  const agentIds = (agents ?? []).map((a: { id: string }) => a.id);

  if (agentIds.length > 0) {
    // Transfer agents to the authenticated user and clear is_anonymous flag
    await supabase
      .from('agents')
      .update({ user_id: user.id, is_anonymous: false })
      .eq('user_id', anonUser.id);
  }

  // Delete the anonymous user row
  await supabase.from('users').delete().eq('id', anonUser.id);

  return json({
    linked: true,
    agentIds,
  } satisfies LinkAccountResponse);
}
