import { Command } from 'commander';
import pc from 'picocolors';
import { DEFAULT_REGISTRY } from '@opencara/shared';
import { loadConfig, CONFIG_FILE, type LocalAgentConfig } from '../config.js';
import { isAuthenticated, loadAuth } from '../auth.js';
import { validateCommandBinary } from '../tool-executor.js';
import { icons } from '../logger.js';

/** Timeout for platform connectivity and metrics requests. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Metrics shape returned by the platform /metrics endpoint. */
interface PlatformMetrics {
  tasks: {
    total: number;
    pending: number;
    reviewing: number;
    completed: number;
    failed: number;
  };
}

/** Validate that a response matches the PlatformMetrics shape. */
function isValidMetrics(data: unknown): data is PlatformMetrics {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  if (!obj.tasks || typeof obj.tasks !== 'object') return false;
  const tasks = obj.tasks as Record<string, unknown>;
  return (
    typeof tasks.pending === 'number' &&
    typeof tasks.reviewing === 'number' &&
    typeof tasks.failed === 'number'
  );
}

/** Determine agent role label from config flags. */
export function agentRoleLabel(agent: LocalAgentConfig): string {
  if (agent.review_only) return 'reviewer only';
  if (agent.synthesizer_only) return 'synthesizer only';
  return 'reviewer+synthesizer';
}

/** Resolve the binary name for a given tool from the registry. */
export function resolveToolBinary(toolName: string): string {
  const entry = DEFAULT_REGISTRY.tools.find((t) => t.name === toolName);
  return entry?.binary ?? toolName;
}

/**
 * Resolve the command template for a given agent.
 * Uses agent.command override, then falls back to registry template.
 * Note: config.ts parseAgents already filters unknown tools, so the
 * registry lookup should always succeed for valid config.
 */
function resolveCommand(agent: LocalAgentConfig): string | null {
  if (agent.command) return agent.command;
  const entry = DEFAULT_REGISTRY.tools.find((t) => t.name === agent.tool);
  return entry?.commandTemplate ?? null;
}

/** Check platform connectivity by hitting /health. Returns elapsed ms or error message. */
export async function checkConnectivity(
  platformUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; ms: number; error?: string }> {
  const start = Date.now();
  try {
    const res = await fetchFn(`${platformUrl}/health`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const ms = Date.now() - start;
    if (!res.ok) {
      return { ok: false, ms, error: `HTTP ${res.status}` };
    }
    return { ok: true, ms };
  } catch (err) {
    const ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, ms, error: message };
  }
}

/** Fetch platform metrics from /metrics. Returns null on failure. */
export async function fetchMetrics(
  platformUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<PlatformMetrics | null> {
  try {
    const res = await fetchFn(`${platformUrl}/metrics`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!isValidMetrics(data)) return null;
    return data;
  } catch {
    return null;
  }
}

/** Format and print the full status output. Exported for testing. */
export async function runStatus(deps: {
  loadConfigFn?: typeof loadConfig;
  fetchFn?: typeof fetch;
  validateBinaryFn?: typeof validateCommandBinary;
  log?: (msg: string) => void;
}): Promise<void> {
  const {
    loadConfigFn = loadConfig,
    fetchFn = fetch,
    validateBinaryFn = validateCommandBinary,
    log = console.log,
  } = deps;

  const config = loadConfigFn();

  // Header
  log(`${pc.bold('OpenCara Agent Status')}`);
  log(pc.dim('\u2500'.repeat(30)));

  // Config section
  log(`Config:     ${pc.cyan(CONFIG_FILE)}`);
  log(`Platform:   ${pc.cyan(config.platformUrl)}`);
  const auth = loadAuth();
  const authed = isAuthenticated();
  if (authed && auth) {
    log(`Auth:       ${icons.success} ${auth.github_username}`);
  } else if (auth) {
    log(`Auth:       ${icons.warn} token expired for ${auth.github_username}`);
  } else {
    log(`Auth:       ${icons.error} not authenticated (run: opencara auth login)`);
  }
  log('');

  // Connectivity section
  const conn = await checkConnectivity(config.platformUrl, fetchFn);
  if (conn.ok) {
    log(`Connectivity: ${icons.success} OK (${conn.ms}ms)`);
  } else {
    log(`Connectivity: ${icons.error} Connection failed: ${conn.error}`);
  }
  log('');

  // Agents section
  const agents = config.agents;
  if (!agents || agents.length === 0) {
    log(`Agents: ${pc.dim('No agents configured')}`);
  } else {
    log(`Agents (${agents.length} configured):`);
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const label = agent.name ?? `${agent.model}/${agent.tool}`;
      const role = agentRoleLabel(agent);
      log(`  ${i + 1}. ${pc.bold(label)} \u2014 ${role}`);

      // Binary check
      const commandTemplate = resolveCommand(agent);
      if (commandTemplate) {
        const binaryOk = validateBinaryFn(commandTemplate);
        const binary = resolveToolBinary(agent.tool);
        if (binaryOk) {
          log(`     Binary: ${icons.success} ${binary} executable`);
        } else {
          log(`     Binary: ${icons.error} ${binary} not found`);
        }
      } else {
        log(`     Binary: ${icons.warn} unknown tool "${agent.tool}"`);
      }
    }
  }
  log('');

  // Platform metrics section
  if (conn.ok) {
    const metrics = await fetchMetrics(config.platformUrl, fetchFn);
    if (metrics) {
      log('Platform Status:');
      log(
        `  Tasks: ${metrics.tasks.pending} pending, ${metrics.tasks.reviewing} reviewing, ${metrics.tasks.failed} failed`,
      );
    } else {
      log(`Platform Status: ${icons.error} Could not fetch metrics`);
    }
  } else {
    log(`Platform Status: ${pc.dim('skipped (no connectivity)')}`);
  }
}

export const statusCommand = new Command('status')
  .description('Show agent config, connectivity, and platform status')
  .action(async () => {
    await runStatus({});
  });
