import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { DEFAULT_REGISTRY } from '@opencara/shared';
import type { RepoConfig, RepoFilterMode } from '@opencara/shared';

export interface LocalAgentConfig {
  model: string;
  tool: string;
  thinking?: string;
  name?: string;
  command?: string;
  router?: boolean;
  roles?: string[];
  review_only?: boolean;
  synthesizer_only?: boolean;
  synthesize_repos?: RepoConfig;
  codebase_dir?: string;
  repos?: RepoConfig;
}

export interface UsageLimits {
  maxReviewsPerDay: number | null;
  maxTokensPerDay: number | null;
  maxTokensPerReview: number | null;
}

export interface CliConfig {
  platformUrl: string;
  maxDiffSizeKb: number;
  maxConsecutiveErrors: number;
  codebaseDir: string | null;
  agentCommand: string | null;
  agents: LocalAgentConfig[] | null; // null = key absent = old server-side behavior
  usageLimits: UsageLimits;
}

export const DEFAULT_PLATFORM_URL = 'https://api.opencara.dev';
export const CONFIG_DIR = path.join(os.homedir(), '.opencara');
export const CONFIG_FILE =
  process.env.OPENCARA_CONFIG && process.env.OPENCARA_CONFIG.trim()
    ? path.resolve(process.env.OPENCARA_CONFIG)
    : path.join(CONFIG_DIR, 'config.toml');

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

/** Backward-compatible aliases for renamed tools. */
const TOOL_ALIASES: Record<string, string> = {
  'claude-code': 'claude',
};

function parseRepoConfig(
  obj: Record<string, unknown>,
  index: number,
  field: string = 'repos',
): RepoConfig | undefined {
  const raw = obj[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') {
    throw new RepoConfigError(`agents[${index}].${field} must be an object`);
  }

  const reposObj = raw as Record<string, unknown>;
  const mode = reposObj.mode;

  if (mode === undefined) {
    throw new RepoConfigError(`agents[${index}].${field}.mode is required`);
  }
  if (typeof mode !== 'string' || !VALID_REPO_MODES.includes(mode as RepoFilterMode)) {
    throw new RepoConfigError(
      `agents[${index}].${field}.mode must be one of: ${VALID_REPO_MODES.join(', ')}`,
    );
  }

  const config: RepoConfig = { mode: mode as RepoFilterMode };

  const list = reposObj.list;
  if (mode === 'whitelist' || mode === 'blacklist') {
    if (!Array.isArray(list) || list.length === 0) {
      throw new RepoConfigError(
        `agents[${index}].${field}.list is required and must be non-empty for mode '${mode}'`,
      );
    }
  }
  if (Array.isArray(list) && list.length > 0) {
    for (let j = 0; j < list.length; j++) {
      if (typeof list[j] !== 'string' || !REPO_PATTERN.test(list[j])) {
        throw new RepoConfigError(
          `agents[${index}].${field}.list[${j}] must match 'owner/repo' format`,
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
    let resolvedTool = obj.tool;
    if (!KNOWN_TOOL_NAMES.has(resolvedTool)) {
      const alias = TOOL_ALIASES[resolvedTool];
      if (alias) {
        console.warn(
          `\u26a0 Config warning: agents[${i}].tool "${resolvedTool}" is deprecated, using "${alias}" instead`,
        );
        resolvedTool = alias;
      } else if (typeof obj.command !== 'string') {
        const toolNames = [...KNOWN_TOOL_NAMES].join(', ');
        console.warn(
          `\u26a0 Config warning: agents[${i}].tool "${resolvedTool}" not in registry (known: ${toolNames}) and no custom command provided, skipping agent`,
        );
        continue;
      }
    }
    const agent: LocalAgentConfig = { model: obj.model, tool: resolvedTool };
    if (typeof obj.thinking === 'string') agent.thinking = obj.thinking;
    else if (typeof obj.thinking === 'number') agent.thinking = String(obj.thinking);
    else if (obj.thinking !== undefined) {
      console.warn(
        `\u26a0 Config warning: agents[${i}].thinking must be a string or number, got ${typeof obj.thinking}, ignoring`,
      );
    }
    if (typeof obj.name === 'string') agent.name = obj.name;
    if (typeof obj.command === 'string') agent.command = obj.command;
    if (obj.router === true) agent.router = true;
    if (Array.isArray(obj.roles)) {
      const validRoles = obj.roles.filter((r): r is string => typeof r === 'string');
      if (validRoles.length > 0) agent.roles = validRoles;
    }
    if (obj.review_only === true) agent.review_only = true;
    if (obj.synthesizer_only === true) agent.synthesizer_only = true;
    if (agent.review_only && agent.synthesizer_only) {
      throw new ConfigValidationError(
        `agents[${i}]: review_only and synthesizer_only cannot both be true`,
      );
    }
    if (agent.roles && (agent.review_only || agent.synthesizer_only)) {
      console.warn(
        `⚠ Config warning: agents[${i}] has both 'roles' and '${agent.review_only ? 'review_only' : 'synthesizer_only'}'. 'roles' takes precedence; review_only/synthesizer_only are deprecated in favor of 'roles'.`,
      );
    }
    if (typeof obj.github_token === 'string') {
      console.warn(
        `\u26a0 Config warning: agents[${i}].github_token is deprecated. Use \`opencara auth login\` for authentication.`,
      );
    }
    if (typeof obj.codebase_dir === 'string') agent.codebase_dir = obj.codebase_dir;
    const repoConfig = parseRepoConfig(obj, i);
    if (repoConfig) agent.repos = repoConfig;
    const synthesizeRepoConfig = parseRepoConfig(obj, i, 'synthesize_repos');
    if (synthesizeRepoConfig) agent.synthesize_repos = synthesizeRepoConfig;
    agents.push(agent);
  }
  return agents;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

interface ValidatedOverrides {
  maxDiffSizeKb?: number;
  maxConsecutiveErrors?: number;
}

/**
 * Validate parsed config data. Warns for optional field issues, throws for required field errors.
 * Returns corrected values for any invalid optional fields instead of mutating the input.
 */
function validateConfigData(
  data: Record<string, unknown>,
  envPlatformUrl: string | null,
): ValidatedOverrides {
  const overrides: ValidatedOverrides = {};

  // Validate platform_url — only check the file value if env is not overriding
  if (
    !envPlatformUrl &&
    typeof data.platform_url === 'string' &&
    !isValidHttpUrl(data.platform_url)
  ) {
    throw new ConfigValidationError(
      `\u2717 Config error: platform_url "${data.platform_url}" is not a valid URL`,
    );
  }

  // Validate numeric bounds
  if (typeof data.max_diff_size_kb === 'number' && data.max_diff_size_kb <= 0) {
    console.warn(
      `\u26a0 Config warning: max_diff_size_kb must be > 0, got ${data.max_diff_size_kb}, using default (${DEFAULT_MAX_DIFF_SIZE_KB})`,
    );
    overrides.maxDiffSizeKb = DEFAULT_MAX_DIFF_SIZE_KB;
  }

  if (typeof data.max_consecutive_errors === 'number' && data.max_consecutive_errors <= 0) {
    console.warn(
      `\u26a0 Config warning: max_consecutive_errors must be > 0, got ${data.max_consecutive_errors}, using default (${DEFAULT_MAX_CONSECUTIVE_ERRORS})`,
    );
    overrides.maxConsecutiveErrors = DEFAULT_MAX_CONSECUTIVE_ERRORS;
  }

  // Validate usage limit fields
  for (const field of [
    'max_reviews_per_day',
    'max_tokens_per_day',
    'max_tokens_per_review',
  ] as const) {
    if (field in data && typeof data[field] === 'number' && (data[field] as number) <= 0) {
      console.warn(
        `\u26a0 Config warning: ${field} must be > 0, got ${data[field]}, ignoring (unlimited)`,
      );
    }
  }

  return overrides;
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  return null;
}

export function loadConfig(): CliConfig {
  const envPlatformUrl = process.env.OPENCARA_PLATFORM_URL?.trim() || null;

  const defaults: CliConfig = {
    platformUrl: envPlatformUrl || DEFAULT_PLATFORM_URL,
    maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
    maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_ERRORS,
    codebaseDir: null,
    agentCommand: null,
    agents: null,
    usageLimits: {
      maxReviewsPerDay: null,
      maxTokensPerDay: null,
      maxTokensPerReview: null,
    },
  };

  if (!fs.existsSync(CONFIG_FILE)) {
    // Backward compatibility: warn if old config.yml exists
    const legacyFile = path.join(CONFIG_DIR, 'config.yml');
    if (fs.existsSync(legacyFile)) {
      console.warn(
        '\u26a0 Found config.yml but config.toml expected. Run `opencara config migrate` or manually rename.',
      );
    }
    return defaults;
  }

  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  let data: Record<string, unknown>;
  try {
    data = parseToml(raw) as Record<string, unknown>;
  } catch {
    return defaults;
  }

  if (!data || typeof data !== 'object') {
    return defaults;
  }

  const overrides = validateConfigData(data, envPlatformUrl);

  // Deprecation warnings for removed fields
  if (typeof data.github_token === 'string') {
    console.warn(
      '\u26a0 Config warning: github_token is deprecated. Use `opencara auth login` for authentication.',
    );
  }
  if (typeof data.github_username === 'string') {
    console.warn(
      '\u26a0 Config warning: github_username is deprecated. Identity is derived from OAuth token.',
    );
  }

  return {
    platformUrl:
      envPlatformUrl ||
      (typeof data.platform_url === 'string' ? data.platform_url : DEFAULT_PLATFORM_URL),
    maxDiffSizeKb:
      overrides.maxDiffSizeKb ??
      (typeof data.max_diff_size_kb === 'number'
        ? data.max_diff_size_kb
        : DEFAULT_MAX_DIFF_SIZE_KB),
    maxConsecutiveErrors:
      overrides.maxConsecutiveErrors ??
      (typeof data.max_consecutive_errors === 'number'
        ? data.max_consecutive_errors
        : DEFAULT_MAX_CONSECUTIVE_ERRORS),
    codebaseDir: typeof data.codebase_dir === 'string' ? data.codebase_dir : null,
    agentCommand: typeof data.agent_command === 'string' ? data.agent_command : null,
    agents: parseAgents(data),
    usageLimits: {
      maxReviewsPerDay: parsePositiveInt(data.max_reviews_per_day),
      maxTokensPerDay: parsePositiveInt(data.max_tokens_per_day),
      maxTokensPerReview: parsePositiveInt(data.max_tokens_per_review),
    },
  };
}

export function saveConfig(config: CliConfig): void {
  ensureConfigDir();
  const data: Record<string, unknown> = {
    platform_url: config.platformUrl,
  };
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
  if (config.usageLimits?.maxReviewsPerDay != null) {
    data.max_reviews_per_day = config.usageLimits.maxReviewsPerDay;
  }
  if (config.usageLimits?.maxTokensPerDay != null) {
    data.max_tokens_per_day = config.usageLimits.maxTokensPerDay;
  }
  if (config.usageLimits?.maxTokensPerReview != null) {
    data.max_tokens_per_review = config.usageLimits.maxTokensPerReview;
  }
  fs.writeFileSync(CONFIG_FILE, stringifyToml(data), { encoding: 'utf-8', mode: 0o600 });
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
