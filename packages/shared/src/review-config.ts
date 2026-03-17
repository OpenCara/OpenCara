import { parse as parseYaml } from 'yaml';

export interface ReviewConfig {
  version: number;
  prompt: string;
  agents: {
    minCount: number;
    preferredTools: string[];
    minReputation: number;
  };
  reviewer: {
    whitelist: Array<{ user?: string; agent?: string }>;
    blacklist: Array<{ user?: string; agent?: string }>;
  };
  summarizer: {
    whitelist: Array<{ user?: string; agent?: string }>;
    blacklist: Array<{ user?: string; agent?: string }>;
  };
  timeout: string;
  autoApprove: {
    enabled: boolean;
    conditions: Array<{ type: string }>;
  };
}

type ParseResult = ReviewConfig | { error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntityList(value: unknown): Array<{ user?: string; agent?: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isObject)
    .map((item) => {
      const entry: { user?: string; agent?: string } = {};
      if (typeof item.user === 'string') entry.user = item.user;
      if (typeof item.agent === 'string') entry.agent = item.agent;
      return entry;
    })
    .filter((entry) => entry.user || entry.agent);
}

function parseTimeout(value: unknown): string {
  if (typeof value !== 'string') return '10m';
  const match = value.match(/^(\d+)m$/);
  if (!match) return '10m';
  const minutes = parseInt(match[1], 10);
  if (minutes < 1 || minutes > 30) return '10m';
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function validateReviewConfig(config: unknown): config is ReviewConfig {
  if (!isObject(config)) return false;
  if (typeof config.version !== 'number') return false;
  if (typeof config.prompt !== 'string') return false;
  return true;
}

/**
 * Default review configuration used when .review.yml is not present in the repo.
 */
export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  version: 1,
  prompt: 'Review this pull request for bugs, security issues, and code quality.',
  agents: {
    minCount: 1,
    preferredTools: [],
    minReputation: 0,
  },
  reviewer: {
    whitelist: [],
    blacklist: [],
  },
  summarizer: {
    whitelist: [],
    blacklist: [],
  },
  timeout: '10m',
  autoApprove: {
    enabled: false,
    conditions: [],
  },
};

export function parseReviewConfig(yaml: string): ParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch {
    return { error: 'Invalid YAML syntax' };
  }

  if (!isObject(raw)) {
    return { error: 'Configuration must be a YAML object' };
  }

  if (raw.version === undefined || raw.version === null) {
    return { error: 'Missing required field: version' };
  }
  if (typeof raw.version !== 'number') {
    return { error: 'Field "version" must be a number' };
  }

  if (raw.prompt === undefined || raw.prompt === null) {
    return { error: 'Missing required field: prompt' };
  }
  if (typeof raw.prompt !== 'string') {
    return { error: 'Field "prompt" must be a string' };
  }

  const agentsRaw = isObject(raw.agents) ? raw.agents : {};
  const reviewerRaw = isObject(raw.reviewer) ? raw.reviewer : {};
  const summarizerRaw = isObject(raw.summarizer) ? raw.summarizer : {};
  const autoApproveRaw = isObject(raw.auto_approve) ? raw.auto_approve : {};

  const config: ReviewConfig = {
    version: raw.version,
    prompt: raw.prompt,
    agents: {
      minCount: clamp(typeof agentsRaw.min_count === 'number' ? agentsRaw.min_count : 1, 1, 10),
      preferredTools: Array.isArray(agentsRaw.preferred_tools)
        ? agentsRaw.preferred_tools.filter((t: unknown) => typeof t === 'string')
        : [],
      minReputation: clamp(
        typeof agentsRaw.min_reputation === 'number' ? agentsRaw.min_reputation : 0.0,
        0.0,
        1.0,
      ),
    },
    reviewer: {
      whitelist: parseEntityList(reviewerRaw.whitelist),
      blacklist: parseEntityList(reviewerRaw.blacklist),
    },
    summarizer: {
      whitelist: parseEntityList(summarizerRaw.whitelist),
      blacklist: parseEntityList(summarizerRaw.blacklist),
    },
    timeout: parseTimeout(raw.timeout),
    autoApprove: {
      enabled: typeof autoApproveRaw.enabled === 'boolean' ? autoApproveRaw.enabled : false,
      conditions: Array.isArray(autoApproveRaw.conditions)
        ? autoApproveRaw.conditions
            .filter(isObject)
            .filter((c) => typeof c.type === 'string')
            .map((c) => ({ type: c.type as string }))
        : [],
    },
  };

  return config;
}
