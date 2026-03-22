import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse, stringify } from 'yaml';
import { DEFAULT_REGISTRY } from '@opencara/shared';
import type { RepoConfig, RepoFilterMode } from '@opencara/shared';

export interface LocalAgentConfig {
  model: string;
  tool: string;
  name?: string;
  command?: string;
  router?: boolean;
  review_only?: boolean;
  github_token?: string;
  codebase_dir?: string;
  repos?: RepoConfig;
}

export interface CliConfig {
  platformUrl: string;
  maxDiffSizeKb: number;
  maxConsecutiveErrors: number;
  githubToken: string | null;
  codebaseDir: string | null;
  agentCommand: string | null;
  agents: LocalAgentConfig[] | null; // null = key absent = old server-side behavior
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
export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 10;

const VALID_REPO_MODES: RepoFilterMode[] = ['all', 'own', 'whitelist', 'blacklist'];
const REPO_PATTERN = /^[^/]+\/[^/]+$/;

export class RepoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoConfigError';
  }
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

const KNOWN_TOOL_NAMES = new Set(DEFAULT_REGISTRY.tools.map((t) => t.name));

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

function parseAgents(data: Record<string, unknown>): LocalAgentConfig[] | null {
  if (!('agents' in data)) return null;
  const raw = data.agents;
  if (!Array.isArray(raw)) return null;

  const agents: LocalAgentConfig[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') {
      console.warn(`\u26a0 Config warning: agents[${i}] is not an object, skipping agent`);
      continue;
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.model !== 'string' || typeof obj.tool !== 'string') {
      console.warn(
        `\u26a0 Config warning: agents[${i}] missing required model/tool fields, skipping agent`,
      );
      continue;
    }
    if (!KNOWN_TOOL_NAMES.has(obj.tool)) {
      const toolNames = [...KNOWN_TOOL_NAMES].join(', ');
      console.warn(
        `\u26a0 Config warning: agents[${i}].tool "${obj.tool}" not in registry (known: ${toolNames}), skipping agent`,
      );
      continue;
    }
    const agent: LocalAgentConfig = { model: obj.model, tool: obj.tool };
    if (typeof obj.name === 'string') agent.name = obj.name;
    if (typeof obj.command === 'string') agent.command = obj.command;
    if (obj.router === true) agent.router = true;
    if (obj.review_only === true) agent.review_only = true;
    if (typeof obj.github_token === 'string') agent.github_token = obj.github_token;
    if (typeof obj.codebase_dir === 'string') agent.codebase_dir = obj.codebase_dir;
    const repoConfig = parseRepoConfig(obj, i);
    if (repoConfig) agent.repos = repoConfig;
    agents.push(agent);
  }
  return agents;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate parsed config data. Warns for optional field issues, throws for required field errors.
 */
function validateConfigData(data: Record<string, unknown>, envPlatformUrl: string | null): void {
  // Validate platform_url — only check the file value if env is not overriding
  if (!envPlatformUrl && typeof data.platform_url === 'string' && !isValidUrl(data.platform_url)) {
    throw new ConfigValidationError(
      `\u2717 Config error: platform_url "${data.platform_url}" is not a valid URL`,
    );
  }

  // Validate numeric bounds
  if (typeof data.max_diff_size_kb === 'number' && data.max_diff_size_kb <= 0) {
    console.warn(
      `\u26a0 Config warning: max_diff_size_kb must be > 0, got ${data.max_diff_size_kb}, using default (${DEFAULT_MAX_DIFF_SIZE_KB})`,
    );
    data.max_diff_size_kb = DEFAULT_MAX_DIFF_SIZE_KB;
  }

  if (typeof data.max_consecutive_errors === 'number' && data.max_consecutive_errors <= 0) {
    console.warn(
      `\u26a0 Config warning: max_consecutive_errors must be > 0, got ${data.max_consecutive_errors}, using default (${DEFAULT_MAX_CONSECUTIVE_ERRORS})`,
    );
    data.max_consecutive_errors = DEFAULT_MAX_CONSECUTIVE_ERRORS;
  }
}

export function loadConfig(): CliConfig {
  const envPlatformUrl = process.env.OPENCARA_PLATFORM_URL?.trim() || null;

  const defaults: CliConfig = {
    platformUrl: envPlatformUrl || DEFAULT_PLATFORM_URL,
    maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
    maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
    githubToken: null,
    codebaseDir: null,
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

  validateConfigData(data, envPlatformUrl);

  return {
    platformUrl:
      envPlatformUrl ||
      (typeof data.platform_url === 'string' ? data.platform_url : DEFAULT_PLATFORM_URL),
    maxDiffSizeKb:
      typeof data.max_diff_size_kb === 'number' ? data.max_diff_size_kb : DEFAULT_MAX_DIFF_SIZE_KB,
    maxConsecutiveErrors:
      typeof data.max_consecutive_errors === 'number'
        ? data.max_consecutive_errors
        : DEFAULT_MAX_CONSECUTIVE_ERRORS,
    githubToken: typeof data.github_token === 'string' ? data.github_token : null,
    codebaseDir: typeof data.codebase_dir === 'string' ? data.codebase_dir : null,
    agentCommand: typeof data.agent_command === 'string' ? data.agent_command : null,
    agents: parseAgents(data),
  };
}

export function saveConfig(config: CliConfig): void {
  ensureConfigDir();
  const data: Record<string, unknown> = {
    platform_url: config.platformUrl,
  };
  if (config.githubToken) {
    data.github_token = config.githubToken;
  }
  if (config.codebaseDir) {
    data.codebase_dir = config.codebaseDir;
  }
  if (config.maxDiffSizeKb !== DEFAULT_MAX_DIFF_SIZE_KB) {
    data.max_diff_size_kb = config.maxDiffSizeKb;
  }
  if (config.maxConsecutiveErrors !== DEFAULT_MAX_CONSECUTIVE_ERRORS) {
    data.max_consecutive_errors = config.maxConsecutiveErrors;
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
 * Resolve GitHub token: per-agent overrides global.
 */
export function resolveGithubToken(
  agentToken: string | undefined,
  globalToken: string | null,
): string | null {
  return agentToken ? agentToken : globalToken;
}

/**
 * Resolve codebase_dir: per-agent overrides global.
 * Expands ~ to home directory.
 */
export function resolveCodebaseDir(
  agentDir: string | undefined,
  globalDir: string | null,
): string | null {
  const raw = agentDir || globalDir;
  if (!raw) return null;
  if (raw.startsWith('~/') || raw === '~') {
    return path.join(os.homedir(), raw.slice(1));
  }
  return path.resolve(raw);
}
