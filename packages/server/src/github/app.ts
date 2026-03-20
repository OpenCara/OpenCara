import type { Env } from '../types.js';

/**
 * Generate a JWT for GitHub App authentication.
 * The JWT is used to request installation access tokens.
 */
async function generateAppJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60, // issued at (60s in the past to allow clock drift)
    exp: now + 600, // expires in 10 minutes
    iss: env.GITHUB_APP_ID,
  };

  const enc = new TextEncoder();
  const headerB64 = base64url(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64url(enc.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const keyData = pemToArrayBuffer(env.GITHUB_APP_PRIVATE_KEY);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(signingInput));
  const signatureB64 = base64url(new Uint8Array(signature));

  return `${signingInput}.${signatureB64}`;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const lines = pem
    .replace(/-----BEGIN [\w ]+ KEY-----/, '')
    .replace(/-----END [\w ]+ KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(lines);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64url(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Get an installation access token for the GitHub App.
 */
export async function getInstallationToken(installationId: number, env: Env): Promise<string> {
  const jwt = await generateAppJwt(env);
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'OpenCara-Server',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Failed to get installation token: ${response.status} ${response.statusText} — ${errorBody}`,
    );
  }

  const data = (await response.json()) as { token: string };
  return data.token;
}
