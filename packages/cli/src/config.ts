import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse, stringify } from 'yaml';

export interface ConsumptionLimits {
  tokens_per_day?: number;
  tokens_per_month?: number;
  reviews_per_day?: number;
}

export interface CliConfig {
  apiKey: string | null;
  platformUrl: string;
  anthropicApiKey: string | null;
  reviewModel: string;
  maxDiffSizeKb: number;
  limits: ConsumptionLimits | null;
}

export const DEFAULT_PLATFORM_URL = 'https://api.opencrust.dev';
export const CONFIG_DIR = path.join(os.homedir(), '.opencrust');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yml');

export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

export const DEFAULT_REVIEW_MODEL = 'claude-sonnet-4-6';
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

export function loadConfig(): CliConfig {
  const defaults: CliConfig = {
    apiKey: null,
    platformUrl: DEFAULT_PLATFORM_URL,
    anthropicApiKey: null,
    reviewModel: DEFAULT_REVIEW_MODEL,
    maxDiffSizeKb: DEFAULT_MAX_DIFF_SIZE_KB,
    limits: null,
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
    anthropicApiKey: typeof data.anthropic_api_key === 'string' ? data.anthropic_api_key : null,
    reviewModel: typeof data.review_model === 'string' ? data.review_model : DEFAULT_REVIEW_MODEL,
    maxDiffSizeKb:
      typeof data.max_diff_size_kb === 'number' ? data.max_diff_size_kb : DEFAULT_MAX_DIFF_SIZE_KB,
    limits: parseLimits(data),
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
  if (config.anthropicApiKey) {
    data.anthropic_api_key = config.anthropicApiKey;
  }
  if (config.reviewModel !== DEFAULT_REVIEW_MODEL) {
    data.review_model = config.reviewModel;
  }
  if (config.maxDiffSizeKb !== DEFAULT_MAX_DIFF_SIZE_KB) {
    data.max_diff_size_kb = config.maxDiffSizeKb;
  }
  if (config.limits) {
    data.limits = config.limits;
  }
  fs.writeFileSync(CONFIG_FILE, stringify(data), { encoding: 'utf-8', mode: 0o600 });
}

export function requireApiKey(config: CliConfig): string {
  if (!config.apiKey) {
    console.error('Not authenticated. Run `opencrust login` first.');
    process.exit(1);
  }
  return config.apiKey;
}
