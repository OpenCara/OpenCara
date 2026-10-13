// What an agent turn runs against: pi's own model runtime over the device's
// pi configuration — `~/.pi/agent/models.json` (custom providers, base-URL
// overrides) and `auth.json` (keys and subscription logins made with the
// `pi` CLI's /login) — with the agent's env layered on top: credentials
// there (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) win over whatever the device
// stores for the turn's provider.

import { join } from "node:path";
import type {
  AuthContext,
  AuthResult,
  ModelThinkingLevel,
  Models,
  ProviderHeaders,
} from "@earendil-works/pi-ai";

export interface PiRuntime {
  models: Models;
  /** Level for agents that set none, as pi itself picks it. */
  defaultThinkingLevel: ModelThinkingLevel;
}

/** Methods that send a provider request and accept per-request auth. */
const REQUEST_METHODS: Record<string, true> = {
  stream: true,
  complete: true,
  streamSimple: true,
  completeSimple: true,
  streamDeferred: true,
  fetchDeferred: true,
  cancelDeferred: true,
};

export async function loadPiRuntime(
  env: Record<string, string>,
  provider: string,
): Promise<PiRuntime> {
  // Loaded on first use: the coding agent takes seconds to import, and every
  // `opencara internal …` worktree job re-executes this binary.
  const { getAgentDir, ModelRuntime, SettingsManager } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const dir = getAgentDir();
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
  });
  // Global settings only: a repo under review must not tune the device.
  // "medium" is pi's built-in default when settings.json sets none.
  const settings = SettingsManager.create(dir, dir, { projectTrusted: false });
  return {
    models: withAgentAuth(runtime, env, provider, await agentEnvAuth(runtime, provider, env)),
    defaultThinkingLevel: settings.getDefaultThinkingLevel() ?? "medium",
  };
}

/** `provider`'s auth as the agent's env alone configures it, if it does. */
async function agentEnvAuth(
  models: Models,
  provider: string,
  env: Record<string, string>,
): Promise<AuthResult | undefined> {
  const apiKey = models.getProvider(provider)?.auth.apiKey;
  if (!apiKey) return undefined;
  const ctx: AuthContext = { env: async (name) => env[name], fileExists: async () => false };
  const signal = AbortSignal.timeout(10_000);
  // `check` is the side-effect-free probe; `resolve` may run commands.
  if (apiKey.check && !(await apiKey.check({ ctx, signal }))) return undefined;
  return apiKey.resolve({ ctx, signal });
}

/**
 * Every request carries the agent's env (pi-ai reads provider config from
 * it); requests to the turn's provider also carry the agent-env auth as
 * explicit options, the only way past a credential the device stores —
 * pi-ai consults env only when nothing is stored. Concurrent turns stay
 * isolated: each turn builds its own runtime.
 */
export function withAgentAuth(
  models: Models,
  env: Record<string, string>,
  provider: string,
  auth: AuthResult | undefined,
): Models {
  return new Proxy(models, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      // Methods run against the real object: the runtime keeps private state.
      if (typeof prop !== "string" || !REQUEST_METHODS[prop]) return value.bind(target);
      return (
        model: { provider: string; baseUrl: string },
        request: unknown,
        options?: { apiKey?: string; headers?: ProviderHeaders; env?: Record<string, string> },
      ) => {
        if (!auth || model.provider !== provider) {
          return value.call(target, model, request, { ...options, env: { ...env, ...options?.env } });
        }
        const { apiKey, headers, baseUrl } = auth.auth;
        return value.call(target, baseUrl ? { ...model, baseUrl } : model, request, {
          ...options,
          env: { ...env, ...auth.env, ...options?.env },
          apiKey: options?.apiKey ?? apiKey,
          headers: { ...headers, ...options?.headers },
        });
      };
    },
  });
}
