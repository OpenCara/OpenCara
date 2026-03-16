import type {
  DeviceFlowResponse,
  DeviceTokenRequest,
  DeviceTokenResponse,
  RevokeResponse,
  User,
} from '@opencrust/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateApiKey, hashApiKey } from '../auth.js';
import type { Env } from '../env.js';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** POST /auth/device — initiate GitHub OAuth device flow */
export async function handleDeviceFlow(env: Env): Promise<Response> {
  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      scope: 'read:user',
    }),
  });

  if (!response.ok) {
    return json({ error: 'Failed to initiate device flow' }, 502);
  }

  const data = (await response.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };

  const result: DeviceFlowResponse = {
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: data.interval,
    deviceCode: data.device_code,
  };

  return json(result);
}

/** POST /auth/device/token — poll for authorization */
export async function handleDeviceToken(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
): Promise<Response> {
  let body: DeviceTokenRequest;
  try {
    body = (await request.json()) as DeviceTokenRequest;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.deviceCode) {
    return json({ error: 'deviceCode is required' }, 400);
  }

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      device_code: body.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });

  const data = (await response.json()) as {
    access_token?: string;
    error?: string;
  };

  if (data.error === 'authorization_pending') {
    return json({ status: 'pending' } satisfies DeviceTokenResponse);
  }

  if (data.error === 'expired_token') {
    return json({ status: 'expired' } satisfies DeviceTokenResponse);
  }

  if (data.error === 'slow_down') {
    return json({ status: 'pending' } satisfies DeviceTokenResponse);
  }

  if (data.error || !data.access_token) {
    return json({ error: 'Authorization failed' }, 502);
  }

  // Fetch GitHub user profile
  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${data.access_token}`,
      Accept: 'application/json',
      'User-Agent': 'OpenCrust',
    },
  });

  if (!userResponse.ok) {
    return json({ error: 'Failed to fetch user profile' }, 502);
  }

  const githubUser = (await userResponse.json()) as {
    id: number;
    login: string;
    avatar_url: string;
  };

  // Generate API key
  const apiKey = await generateApiKey();
  const apiKeyHash = await hashApiKey(apiKey);

  // Upsert user
  const { error: upsertError } = await supabase.from('users').upsert(
    {
      github_id: githubUser.id,
      name: githubUser.login,
      avatar: githubUser.avatar_url,
      api_key_hash: apiKeyHash,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'github_id' },
  );

  if (upsertError) {
    return json({ error: 'Failed to save user' }, 500);
  }

  return json({
    status: 'complete',
    apiKey,
  } satisfies DeviceTokenResponse);
}

/** POST /auth/revoke — revoke current API key and issue a new one */
export async function handleRevokeKey(user: User, supabase: SupabaseClient): Promise<Response> {
  const newApiKey = await generateApiKey();
  const newHash = await hashApiKey(newApiKey);

  const { error } = await supabase
    .from('users')
    .update({ api_key_hash: newHash, updated_at: new Date().toISOString() })
    .eq('id', user.id);

  if (error) {
    return json({ error: 'Failed to revoke key' }, 500);
  }

  return json({ apiKey: newApiKey } satisfies RevokeResponse);
}
