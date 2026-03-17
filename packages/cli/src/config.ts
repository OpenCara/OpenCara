import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse, stringify } from 'yaml';

export interface ConsumptionLimits {
  tokens_per_day?: number;
  tokens_per_month?: number;
  reviews_per_day?: number;
}

export interface LocalAgentConfig {
  model: string;
  tool: string;
  command?: string;
  limits?: ConsumptionLimits;
}

export interface CliConfig {
  apiKey: string | null;
  platformUrl: string;
  maxDiffSizeKb: number;
  limits: ConsumptionLimits | null;
  agentCommand: string | null;
  agents: LocalAgentConfig[] | null; // null = key absent = old server-side behavior
}

export const DEFAULT_PLATFORM_URL = 'https://api.opencara.dev';
export const CONFIG_DIR = path.join(os.homedir(), '.opencara');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yml');

export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

export const DEFAULT_MAX_DIFF_SIZE_KB = 100;

function parseLimits(data: Record<string, unknown>): ConsumptionLimits | null {
  const raw = data.limits;
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const limits: ConsumptionLimits = {};
  if (typeof obj.tokens_per_day === 'number') limits.tokens_per_day = obj.tokens_per_day;
  if (typeof obj.tokens_per_month === 'number') limits.tokens_per_month = obj.tokens_per_month;
  if (typeof obj.reviews_per_day === 'number') limits.reviews_per_day = obj.reviews_per_day;
  if (Object.keys(limits).length === 0) return null;
  return limits;
}

function parseAgents(data: Record<string, unknown>): LocalAgentConfig[] | null {
  if (!('agents' in data)) return null;
  const raw = data.agents;
  if (!Array.isArray(raw)) return null;

  const agents: LocalAgentConfig[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') {
      console.warn(`Warning: agents[${i}] is not an object, skipping`);
      continue;
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.model !== 'string' || typeof obj.tool !== 'string') {
      console.warn(`Warning: agents[${i}] missing required model/tool fields, skipping`);
      continue;
    }
    const agent: LocalAgentConfig = { model: obj.model, tool: obj.tool };
    if (typeof obj.command === 'string') agent.command = obj.command;
    const agentLimits = parseLimits(obj);
    if (agentLimits) agent.limits = agentLimits;
    agents.push(agent);
  }
  return agents;
}

export function loadConfig(): CliConfig {
  const defaults: CliConfig = {
    apiKey: null,
    platformUrl: DEFAULT_PLATFORM_URL,
    maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
    limits: null,
    agentCommand: null,
    agents: null,
  };

  if (!fs.existsSync(CONFIG_FILE)) {
    return defaults;
  }

  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  const data = parse(raw) as Record<string, unknown> | null;

  if (!data || typeof data !== 'object') {
    return defaults;
  }

  return {
    apiKey: typeof data.api_key === 'string' ? data.api_key : null,
    platformUrl: typeof data.platform_url === 'string' ? data.platform_url : DEFAULT_PLATFORM_URL,
    maxDiffSizeKb:
      typeof data.max_diff_size_kb === 'number' ? data.max_diff_size_kb : DEFAULT_MAX_DIFF_SIZE_KB,
    limits: parseLimits(data),
    agentCommand: typeof data.agent_command === 'string' ? data.agent_command : null,
    agents: parseAgents(data),
  };
}

export function saveConfig(config: CliConfig): void {
  ensureConfigDir();
  const data: Record<string, unknown> = {
    platform_url: config.platformUrl,
  };
  if (config.apiKey) {
    data.api_key = config.apiKey;
  }
  if (config.maxDiffSizeKb !== DEFAULT_MAX_DIFF_SIZE_KB) {
    data.max_diff_size_kb = config.maxDiffSizeKb;
  }
  if (config.limits) {
    data.limits = config.limits;
  }
  if (config.agentCommand) {
    data.agent_command = config.agentCommand;
  }
  if (config.agents !== null) {
    data.agents = config.agents;
  }
  fs.writeFileSync(CONFIG_FILE, stringify(data), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Merge per-agent limits with global limits.
 * Agent values override global; missing fields fall back to global.
 */
export function resolveAgentLimits(
  agentLimits: ConsumptionLimits | undefined,
  globalLimits: ConsumptionLimits | null,
): ConsumptionLimits | null {
  if (!agentLimits && !globalLimits) return null;
  if (!agentLimits) return globalLimits;
  if (!globalLimits) return agentLimits;
  const merged: ConsumptionLimits = { ...globalLimits, ...agentLimits };
  return Object.keys(merged).length === 0 ? null : merged;
}

export function requireApiKey(config: CliConfig): string {
  if (!config.apiKey) {
    console.error('Not authenticated. Run `opencara login` first.');
    process.exit(1);
  }
  return config.apiKey;
}
