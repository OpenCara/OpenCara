import { parse as parseToml } from 'smol-toml';

export interface TriggerConfig {
  on: string[];
  comment: string;
  skip: string[];
}

/** An entry in a whitelist/blacklist/preferred list — identifies by agent ID or GitHub username */
export type EntityEntry = { agent?: string; github?: string };

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
    whitelist: EntityEntry[];
    blacklist: EntityEntry[];
  };
  summarizer: {
    whitelist: EntityEntry[];
    blacklist: EntityEntry[];
    preferred: EntityEntry[];
  };
  timeout: string;
}

type ParseResult = ReviewConfig | { error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseEntityList(value: unknown): EntityEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: EntityEntry[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    if (
      typeof item.user === 'string' &&
      typeof item.agent !== 'string' &&
      typeof item.github !== 'string'
    ) {
      console.warn(
        `Ignoring "user" entry in whitelist/blacklist: "${item.user}". Use "agent" or "github" entries instead.`,
      );
      continue;
    }
    const entry: EntityEntry = {};
    if (typeof item.agent === 'string') entry.agent = item.agent;
    if (typeof item.github === 'string') entry.github = item.github;
    if (entry.agent !== undefined || entry.github !== undefined) {
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * Check if an agent/user matches an entity entry.
 * Matches if the entry's agent field equals agentId OR the entry's github field equals githubUsername.
 */
export function isEntityMatch(
  entry: EntityEntry,
  agentId?: string,
  githubUsername?: string,
): boolean {
  if (entry.agent !== undefined && agentId !== undefined && entry.agent === agentId) return true;
  if (
    entry.github !== undefined &&
    githubUsername !== undefined &&
    entry.github.toLowerCase() === githubUsername.toLowerCase()
  )
    return true;
  return false;
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
 * Default review configuration used when .review.toml is not present in the repo.
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
  },
  summarizer: {
    whitelist: [],
    blacklist: [],
    preferred: [],
  },
  timeout: '10m',
};

/**
 * Parse a shorthand string into a GitHub entity entry.
 * Used for summarizer shorthand: "alice" → { github: "alice" }
 */
function toGithubEntity(name: string): EntityEntry {
  return { github: name };
}

/**
 * Parse the summarizer section, supporting shorthand forms:
 *
 * 1. String shorthand: `summarizer: alice` → preferred: [{ github: "alice" }]
 * 2. Object with `only` string: `summarizer: { only: alice }` → whitelist: [{ github: "alice" }]
 * 3. Object with `only` list: `summarizer: { only: [alice, bob] }` → whitelist: [{ github: "alice" }, { github: "bob" }]
 * 4. Full object (existing): `summarizer: { whitelist: [...], blacklist: [...], preferred: [...] }`
 */
function parseSummarizerSection(raw: unknown): ReviewConfig['summarizer'] {
  const defaults: ReviewConfig['summarizer'] = {
    whitelist: [],
    blacklist: [],
    preferred: [],
  };

  // String shorthand: "alice" → preferred with github username
  if (typeof raw === 'string') {
    return { ...defaults, preferred: [toGithubEntity(raw)] };
  }

  if (!isObject(raw)) return defaults;

  // Object with "only" key — whitelist-only mode
  if (raw.only !== undefined) {
    if (typeof raw.only === 'string') {
      return { ...defaults, whitelist: [toGithubEntity(raw.only)] };
    }
    if (Array.isArray(raw.only)) {
      const entries = raw.only
        .filter((v: unknown) => typeof v === 'string')
        .map((v: unknown) => toGithubEntity(v as string));
      return { ...defaults, whitelist: entries };
    }
    return defaults;
  }

  // Full object (existing behavior)
  return {
    whitelist: parseEntityList(raw.whitelist),
    blacklist: parseEntityList(raw.blacklist),
    preferred: parseEntityList(raw.preferred),
  };
}

export function parseReviewConfig(toml: string): ParseResult {
  let raw: unknown;
  try {
    raw = parseToml(toml);
  } catch {
    return { error: 'Invalid TOML syntax' };
  }

  if (!isObject(raw)) {
    return { error: 'Configuration must be a TOML document' };
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
    },
    summarizer: parseSummarizerSection(raw.summarizer),
    timeout: parseTimeout(raw.timeout),
  };

  return config;
}
