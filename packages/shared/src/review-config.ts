import { parse as parseYaml } from 'yaml';

export interface TriggerConfig {
  on: string[];
  comment: string;
  skip: string[];
}

export interface ReviewConfig {
  version: number;
  prompt: string;
  trigger: TriggerConfig;
  agents: {
    reviewCount: number;
    preferredModels: string[];
    preferredTools: string[];
  };
  reviewer: {
    whitelist: Array<{ agent: string }>;
    blacklist: Array<{ agent: string }>;
    allowAnonymous: boolean;
  };
  summarizer: {
    whitelist: Array<{ agent: string }>;
    blacklist: Array<{ agent: string }>;
    preferred: Array<{ agent: string }>;
  };
  timeout: string;
}

type ParseResult = ReviewConfig | { error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntityList(value: unknown): Array<{ agent: string }> {
  if (!Array.isArray(value)) return [];
  const entries: Array<{ agent: string }> = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    if (typeof item.user === 'string' && typeof item.agent !== 'string') {
      console.warn(
        `Ignoring "user" entry in whitelist/blacklist: "${item.user}". Only "agent" entries are supported.`,
      );
      continue;
    }
    if (typeof item.agent === 'string') {
      entries.push({ agent: item.agent });
    }
  }
  return entries;
}

function parsePreferredList(value: unknown): Array<{ agent: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isObject)
    .filter((item) => typeof item.agent === 'string')
    .map((item) => ({ agent: item.agent as string }));
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
const DEFAULT_TRIGGER: TriggerConfig = {
  on: ['opened'],
  comment: '/opencara review',
  skip: ['draft'],
};

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  version: 1,
  prompt: 'Review this pull request for bugs, security issues, and code quality.',
  trigger: DEFAULT_TRIGGER,
  agents: {
    reviewCount: 1,
    preferredModels: [],
    preferredTools: [],
  },
  reviewer: {
    whitelist: [],
    blacklist: [],
    allowAnonymous: true,
  },
  summarizer: {
    whitelist: [],
    blacklist: [],
    preferred: [],
  },
  timeout: '10m',
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

  const triggerRaw = isObject(raw.trigger) ? raw.trigger : {};
  const agentsRaw = isObject(raw.agents) ? raw.agents : {};
  const reviewerRaw = isObject(raw.reviewer) ? raw.reviewer : {};
  const summarizerRaw = isObject(raw.summarizer) ? raw.summarizer : {};

  const config: ReviewConfig = {
    version: raw.version,
    prompt: raw.prompt,
    trigger: {
      on: Array.isArray(triggerRaw.on)
        ? triggerRaw.on.filter((v: unknown) => typeof v === 'string')
        : DEFAULT_TRIGGER.on,
      comment:
        typeof triggerRaw.comment === 'string' ? triggerRaw.comment : DEFAULT_TRIGGER.comment,
      skip: Array.isArray(triggerRaw.skip)
        ? triggerRaw.skip.filter((v: unknown) => typeof v === 'string')
        : DEFAULT_TRIGGER.skip,
    },
    agents: {
      reviewCount: clamp(
        typeof agentsRaw.review_count === 'number' ? agentsRaw.review_count : 1,
        1,
        10,
      ),
      preferredModels: Array.isArray(agentsRaw.preferred_models)
        ? agentsRaw.preferred_models.filter((t: unknown) => typeof t === 'string')
        : [],
      preferredTools: Array.isArray(agentsRaw.preferred_tools)
        ? agentsRaw.preferred_tools.filter((t: unknown) => typeof t === 'string')
        : [],
    },
    reviewer: {
      whitelist: parseEntityList(reviewerRaw.whitelist),
      blacklist: parseEntityList(reviewerRaw.blacklist),
      allowAnonymous:
        typeof reviewerRaw.allow_anonymous === 'boolean' ? reviewerRaw.allow_anonymous : true,
    },
    summarizer: {
      whitelist: parseEntityList(summarizerRaw.whitelist),
      blacklist: parseEntityList(summarizerRaw.blacklist),
      preferred: parsePreferredList(summarizerRaw.preferred),
    },
    timeout: parseTimeout(raw.timeout),
  };

  return config;
}
