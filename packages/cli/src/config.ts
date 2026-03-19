import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse, stringify } from 'yaml';
import type { RepoConfig, RepoFilterMode } from '@opencara/shared';

export interface ConsumptionLimits {
  tokens_per_day?: number;
  tokens_per_month?: number;
  reviews_per_day?: number;
}

export interface LocalAgentConfig {
  model: string;
  tool: string;
  name?: string;
  command?: string;
  router?: boolean;
  limits?: ConsumptionLimits;
  repos?: RepoConfig;
}

export interface AnonymousAgentEntry {
  agentId: string;
  apiKey: string; // cr_ key
  model: string;
  tool: string;
  name?: string;
  repoConfig?: RepoConfig;
}

export interface CliConfig {
  apiKey: string | null;
  platformUrl: string;
  maxDiffSizeKb: number;
  limits: ConsumptionLimits | null;
  agentCommand: string | null;
  agents: LocalAgentConfig[] | null; // null = key absent = old server-side behavior
  anonymousAgents: AnonymousAgentEntry[];
}

export const DEFAULT_PLATFORM_URL = 'https://api.opencara.dev';
export const CONFIG_DIR = path.join(os.homedir(), '.opencara');
export const CONFIG_FILE =
  process.env.OPENCARA_CONFIG && process.env.OPENCARA_CONFIG.trim()
    ? path.resolve(process.env.OPENCARA_CONFIG)
    : path.join(CONFIG_DIR, 'config.yml');

export function ensureConfigDir(): void {
  const dir = path.dirname(CONFIG_FILE);
  fs.mkdirSync(dir, { recursive: true });
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

const VALID_REPO_MODES: RepoFilterMode[] = ['all', 'own', 'whitelist', 'blacklist'];
const REPO_PATTERN = /^[^/]+\/[^/]+$/;

export class RepoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoConfigError';
  }
}

function parseRepoConfig(obj: Record<string, unknown>, index: number): RepoConfig | undefined {
  const raw = obj.repos;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') {
    throw new RepoConfigError(`agents[${index}].repos must be an object`);
  }

  const reposObj = raw as Record<string, unknown>;
  const mode = reposObj.mode;

  if (mode === undefined) {
    throw new RepoConfigError(`agents[${index}].repos.mode is required`);
  }
  if (typeof mode !== 'string' || !VALID_REPO_MODES.includes(mode as RepoFilterMode)) {
    throw new RepoConfigError(
      `agents[${index}].repos.mode must be one of: ${VALID_REPO_MODES.join(', ')}`,
    );
  }

  const config: RepoConfig = { mode: mode as RepoFilterMode };

  if (mode === 'whitelist' || mode === 'blacklist') {
    const list = reposObj.list;
    if (!Array.isArray(list) || list.length === 0) {
      throw new RepoConfigError(
        `agents[${index}].repos.list is required and must be non-empty for mode '${mode}'`,
      );
    }
    for (let j = 0; j < list.length; j++) {
      if (typeof list[j] !== 'string' || !REPO_PATTERN.test(list[j])) {
        throw new RepoConfigError(
          `agents[${index}].repos.list[${j}] must match 'owner/repo' format`,
        );
      }
    }
    config.list = list as string[];
  }

  return config;
}

function parseAnonymousAgents(data: Record<string, unknown>): AnonymousAgentEntry[] {
  const raw = data.anonymous_agents;
  if (!Array.isArray(raw)) return [];

  const entries: AnonymousAgentEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') {
      console.warn(`Warning: anonymous_agents[${i}] is not an object, skipping`);
      continue;
    }
    const obj = entry as Record<string, unknown>;
    if (
      typeof obj.agent_id !== 'string' ||
      typeof obj.api_key !== 'string' ||
      typeof obj.model !== 'string' ||
      typeof obj.tool !== 'string'
    ) {
      console.warn(
        `Warning: anonymous_agents[${i}] missing required agent_id/api_key/model/tool fields, skipping`,
      );
      continue;
    }
    const anon: AnonymousAgentEntry = {
      agentId: obj.agent_id,
      apiKey: obj.api_key,
      model: obj.model,
      tool: obj.tool,
    };
    if (typeof obj.name === 'string') anon.name = obj.name;
    if (obj.repo_config && typeof obj.repo_config === 'object') {
      const rc = obj.repo_config as Record<string, unknown>;
      if (typeof rc.mode === 'string' && VALID_REPO_MODES.includes(rc.mode as RepoFilterMode)) {
        const repoConfig: RepoConfig = { mode: rc.mode as RepoFilterMode };
        if (Array.isArray(rc.list)) {
          repoConfig.list = rc.list.filter((v): v is string => typeof v === 'string');
        }
        anon.repoConfig = repoConfig;
      }
    }
    entries.push(anon);
  }
  return entries;
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
    if (typeof obj.name === 'string') agent.name = obj.name;
    if (typeof obj.command === 'string') agent.command = obj.command;
    if (obj.router === true) agent.router = true;
    const agentLimits = parseLimits(obj);
    if (agentLimits) agent.limits = agentLimits;
    const repoConfig = parseRepoConfig(obj, i);
    if (repoConfig) agent.repos = repoConfig;
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
    anonymousAgents: [],
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
    anonymousAgents: parseAnonymousAgents(data),
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
  if (config.anonymousAgents.length > 0) {
    data.anonymous_agents = config.anonymousAgents.map((a) => {
      const entry: Record<string, unknown> = {
        agent_id: a.agentId,
        api_key: a.apiKey,
        model: a.model,
        tool: a.tool,
      };
      if (a.name) {
        entry.name = a.name;
      }
      if (a.repoConfig) {
        entry.repo_config = a.repoConfig;
      }
      return entry;
    });
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

export function findAnonymousAgent(config: CliConfig, agentId: string): AnonymousAgentEntry | null {
  return config.anonymousAgents.find((a) => a.agentId === agentId) ?? null;
}

export function removeAnonymousAgent(config: CliConfig, agentId: string): void {
  config.anonymousAgents = config.anonymousAgents.filter((a) => a.agentId !== agentId);
}

export function requireApiKey(config: CliConfig): string {
  if (!config.apiKey) {
    console.error('Not authenticated. Run `opencara login` first.');
    process.exit(1);
  }
  return config.apiKey;
}
