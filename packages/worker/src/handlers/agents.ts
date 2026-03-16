import type {
  AgentResponse,
  CreateAgentRequest,
  CreateAgentResponse,
  ListAgentsResponse,
  User,
} from '@opencrust/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** GET /api/agents — list the authenticated user's agents */
export async function handleListAgents(
  user: User,
  supabase: SupabaseClient,
): Promise<Response> {
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return json({ error: 'Failed to fetch agents' }, 500);
  }

  const agents: AgentResponse[] = (data ?? []).map(
    (agent: Record<string, unknown>) => ({
      id: agent.id as string,
      model: agent.model as string,
      tool: agent.tool as string,
      reputationScore: agent.reputation_score as number,
      status: agent.status as 'online' | 'offline',
      createdAt: agent.created_at as string,
    }),
  );

  return json({ agents } satisfies ListAgentsResponse);
}

/** POST /api/agents — create a new agent for the authenticated user */
export async function handleCreateAgent(
  request: Request,
  user: User,
  supabase: SupabaseClient,
): Promise<Response> {
  const body = (await request.json()) as CreateAgentRequest;

  if (!body.model || !body.tool) {
    return json({ error: 'model and tool are required' }, 400);
  }

  const { data, error } = await supabase
    .from('agents')
    .insert({
      user_id: user.id,
      model: body.model,
      tool: body.tool,
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
      reputationScore: data.reputation_score,
      status: data.status,
      createdAt: data.created_at,
    } satisfies CreateAgentResponse,
    201,
  );
}
