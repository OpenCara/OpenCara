import type {
  AgentResponse,
  CreateAgentRequest,
  CreateAgentResponse,
  ListAgentsResponse,
  User,
} from '@opencara/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** GET /api/agents — list the authenticated user's agents */
export async function handleListAgents(user: User, supabase: SupabaseClient): Promise<Response> {
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return json({ error: 'Failed to fetch agents' }, 500);
  }

  const agents: AgentResponse[] = (data ?? []).map((agent: Record<string, unknown>) => ({
    id: agent.id as string,
    model: agent.model as string,
    tool: agent.tool as string,
    isAnonymous: (agent.is_anonymous as boolean) ?? false,
    status: agent.status as 'online' | 'offline',
    repoConfig: (agent.repo_config as AgentResponse['repoConfig']) ?? null,
    createdAt: agent.created_at as string,
  }));

  return json({ agents } satisfies ListAgentsResponse);
}

/** POST /api/agents — create a new agent for the authenticated user */
export async function handleCreateAgent(
  request: Request,
  user: User,
  supabase: SupabaseClient,
): Promise<Response> {
  let body: CreateAgentRequest;
  try {
    body = (await request.json()) as CreateAgentRequest;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.model || !body.tool) {
    return json({ error: 'model and tool are required' }, 400);
  }

  const { data, error } = await supabase
    .from('agents')
    .insert({
      user_id: user.id,
      model: body.model,
      tool: body.tool,
      ...(body.repoConfig ? { repo_config: body.repoConfig } : {}),
    })
    .select()
    .single();

  if (error) {
    return json({ error: 'Failed to create agent' }, 500);
  }

  return json(
    {
      id: data.id,
      model: data.model,
      tool: data.tool,
      isAnonymous: data.is_anonymous ?? false,
      status: data.status,
      repoConfig: data.repo_config ?? null,
      createdAt: data.created_at,
    } satisfies CreateAgentResponse,
    201,
  );
}
