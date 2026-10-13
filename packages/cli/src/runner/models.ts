// What an agent turn runs against: pi's own model runtime over the device's
// pi configuration — `~/.pi/agent/models.json` (custom providers, base-URL
// overrides), `auth.json` (keys and subscription logins made with the `pi`
// CLI's /login) and the provider extensions of its installed pi packages
// (`pi install npm:…`) — with the agent's env layered on top: credentials
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
import type { LoadExtensionsResult, ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface PiRuntime {
  models: Models;
  /** Level for agents that set none, as pi itself picks it. */
  defaultThinkingLevel: ModelThinkingLevel;
  /** Device pi extensions that failed to load or register; the turn runs without them. */
  warnings?: string[];
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

/** Request methods that return an event stream (with `result()`). */
const STREAM_METHODS: Record<string, true> = { stream: true, streamSimple: true };

export async function loadPiRuntime(
  env: Record<string, string>,
  provider: string,
): Promise<PiRuntime> {
  // Loaded on first use: the coding agent takes seconds to import, and every
  // `opencara internal …` worktree job re-executes this binary.
  const { DefaultResourceLoader, getAgentDir, ModelRuntime, SettingsManager } = await import(
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
  const loader = new DefaultResourceLoader({
    // Resolved from the agent dir, not the run's worktree: a repo under
    // review must not bring extensions of its own.
    cwd: dir,
    agentDir: dir,
    settingsManager: settings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const warnings: string[] = [];
  const extensionProviders = registerExtensionProviders(runtime, loader.getExtensions(), warnings);
  if (extensionProviders.has(provider)) {
    // Extension providers own their catalogs: dynamic ones start empty or
    // from a cached snapshot, others list a fallback until they've fetched.
    // Refresh the turn's provider so its current models are there.
    const { errors } = await runtime.refresh({
      allowNetwork: true,
      force: true,
      providers: [provider],
      signal: AbortSignal.timeout(30_000),
    });
    for (const [id, err] of errors) warnings.push(`provider ${id}: model catalog refresh failed: ${err.message}`);
  }
  return {
    models: withAgentAuth(runtime, env, provider, await agentEnvAuth(runtime, provider, env)),
    defaultThinkingLevel: settings.getDefaultThinkingLevel() ?? "medium",
    warnings,
  };
}

/**
 * Apply the providers and virtual models the extensions registered while
 * loading, and route later registrations (a catalog fetched in the
 * background, after a token refresh) straight to `runtime` — what pi's own
 * extension runner does once bound. Everything else an extension registers
 * (tools, commands, UI) is for interactive pi and is ignored here. Returns
 * the ids of the providers the extensions registered.
 */
function registerExtensionProviders(
  runtime: ModelRuntime,
  loaded: LoadExtensionsResult,
  warnings: string[],
): Set<string> {
  warnings.push(
    ...loaded.errors.map((e) => `pi extension ${e.path} failed to load: ${e.error}`),
    ...(loaded.warnings ?? []).map((w) => `pi extension ${w.path}: ${w.warning}`),
  );
  const providers = new Set<string>();
  const apply = (extensionPath: string, register: () => void) => {
    try {
      register();
    } catch (err) {
      warnings.push(`pi extension ${extensionPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const state = loaded.runtime;
  for (const { name, config, extensionPath } of state.pendingProviderRegistrations) {
    apply(extensionPath, () => runtime.registerProvider(name, config));
    providers.add(name);
  }
  for (const { provider, extensionPath } of state.pendingNativeProviderRegistrations) {
    apply(extensionPath, () => runtime.registerNativeProvider(provider));
    providers.add(provider.id);
  }
  for (const { definition, extensionPath } of state.pendingVirtualModelRegistrations) {
    apply(extensionPath, () => runtime.registerVirtualModel(definition));
  }
  state.pendingProviderRegistrations = [];
  state.pendingNativeProviderRegistrations = [];
  state.pendingVirtualModelRegistrations = [];
  state.registerProvider = (name, config) => runtime.registerProvider(name, config);
  state.registerNativeProvider = (provider) => runtime.registerNativeProvider(provider);
  state.unregisterProvider = (name) => runtime.unregisterProvider(name);
  state.registerVirtualModel = (definition) => runtime.registerVirtualModel(definition);
  state.unregisterVirtualModel = (provider, id) => runtime.unregisterVirtualModel(provider, id);
  return providers;
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
 *
 * A stream's abort signal is forwarded only while the response is still
 * coming in. pi-durable aborts a generation's signal as soon as the
 * generation settles, while providers that keep a server-side run open
 * across tool calls (Cursor's agent runs) tie that run to the signal of the
 * request that last continued it — so the settle would tear down the run the
 * tool results are about to continue.
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
        options?: {
          apiKey?: string;
          headers?: ProviderHeaders;
          env?: Record<string, string>;
          signal?: AbortSignal;
        },
      ) => {
        let call = { ...options, env: { ...env, ...options?.env } };
        let requestModel = model;
        if (auth && model.provider === provider) {
          const { apiKey, headers, baseUrl } = auth.auth;
          if (baseUrl) requestModel = { ...model, baseUrl };
          call = {
            ...call,
            env: { ...env, ...auth.env, ...options?.env },
            apiKey: options?.apiKey ?? apiKey,
            headers: { ...headers, ...options?.headers },
          };
        }
        const signal = options?.signal;
        if (!STREAM_METHODS[prop] || !signal || signal.aborted) {
          return value.call(target, requestModel, request, call);
        }
        const linked = new AbortController();
        const forward = () => linked.abort(signal.reason);
        signal.addEventListener("abort", forward, { once: true });
        const stream = value.call(target, requestModel, request, { ...call, signal: linked.signal }) as {
          result(): Promise<unknown>;
        };
        void stream.result().finally(() => signal.removeEventListener("abort", forward));
        return stream;
      };
    },
  });
}
