import { parse as parseToml } from 'smol-toml';

export interface TriggerConfig {
  on: string[];
  comment: string;
  skip: string[];
}

/** An entry in a whitelist/blacklist/preferred list — identifies by agent ID or GitHub username */
export type EntityEntry = { agent?: string; github?: string };

/** Per-agent slot overrides within a feature section */
export interface AgentSlotConfig {
  prompt?: string;
  preferredModels?: string[];
  preferredTools?: string[];
}

/** Base config shared by all features (review, dedup, triage) */
export interface FeatureConfig {
  prompt: string;
  agentCount: number;
  timeout: string;
  preferredModels: string[];
  preferredTools: string[];
  agents?: AgentSlotConfig[];
}

/** Review section — extends FeatureConfig with trigger and access control */
export interface ReviewSectionConfig extends FeatureConfig {
  trigger: TriggerConfig;
  reviewer: { whitelist: EntityEntry[]; blacklist: EntityEntry[] };
  summarizer: { whitelist: EntityEntry[]; blacklist: EntityEntry[]; preferred: EntityEntry[] };
}

/** Dedup target config for PRs */
export interface DedupTargetConfig extends FeatureConfig {
  enabled: boolean;
  indexIssue?: number;
}

/** Dedup target config for issues — adds includeClosed option */
export interface DedupIssueTargetConfig extends DedupTargetConfig {
  includeClosed?: boolean;
}

/** Dedup section with PR and issue sub-targets */
export interface DedupConfig {
  prs?: DedupTargetConfig;
  issues?: DedupIssueTargetConfig;
}

/** Triage section config */
export interface TriageConfig extends FeatureConfig {
  enabled: boolean;
  defaultMode: 'comment' | 'rewrite';
  autoLabel: boolean;
  triggers: string[];
  authorModes?: Record<string, 'comment' | 'rewrite'>;
}

/** Top-level .opencara.toml config */
export interface OpenCaraConfig {
  version: number;
  review?: ReviewSectionConfig;
  dedup?: DedupConfig;
  triage?: TriageConfig;
}

/**
 * Legacy ReviewConfig — kept as an alias for ReviewSectionConfig.
 * Used on ReviewTask.config and throughout the server/CLI.
 */
export type ReviewConfig = ReviewSectionConfig;

type ParseResult = OpenCaraConfig | { error: string };

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

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v: unknown) => typeof v === 'string');
}

export function validateReviewConfig(config: unknown): config is ReviewConfig {
  if (!isObject(config)) return false;
  if (typeof config.prompt !== 'string') return false;
  return true;
}

/** Validate an OpenCaraConfig — requires version and at least a review section with prompt */
export function validateOpenCaraConfig(config: unknown): config is OpenCaraConfig {
  if (!isObject(config)) return false;
  if (typeof config.version !== 'number') return false;
  return true;
}

/**
 * Default review configuration used when .opencara.toml is not present in the repo.
 */
const DEFAULT_TRIGGER: TriggerConfig = {
  on: ['opened'],
  comment: '/opencara review',
  skip: ['draft'],
};

const DEFAULT_FEATURE_CONFIG: FeatureConfig = {
  prompt: 'Review this pull request for bugs, security issues, and code quality.',
  agentCount: 1,
  timeout: '10m',
  preferredModels: [],
  preferredTools: [],
};

export const DEFAULT_REVIEW_SECTION: ReviewSectionConfig = {
  ...DEFAULT_FEATURE_CONFIG,
  trigger: DEFAULT_TRIGGER,
  reviewer: { whitelist: [], blacklist: [] },
  summarizer: { whitelist: [], blacklist: [], preferred: [] },
};

/** @deprecated Use DEFAULT_REVIEW_SECTION instead */
export const DEFAULT_REVIEW_CONFIG: ReviewConfig = DEFAULT_REVIEW_SECTION;

export const DEFAULT_OPENCARA_CONFIG: OpenCaraConfig = {
  version: 1,
  review: DEFAULT_REVIEW_SECTION,
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
function parseSummarizerSection(raw: unknown): ReviewSectionConfig['summarizer'] {
  const defaults: ReviewSectionConfig['summarizer'] = {
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

/** Parse [[feature.agents]] array into AgentSlotConfig[] */
function parseAgentSlots(value: unknown): AgentSlotConfig[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const slots: AgentSlotConfig[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const slot: AgentSlotConfig = {};
    if (typeof item.prompt === 'string') slot.prompt = item.prompt;
    if (Array.isArray(item.preferred_models)) {
      slot.preferredModels = parseStringArray(item.preferred_models);
    }
    if (Array.isArray(item.preferred_tools)) {
      slot.preferredTools = parseStringArray(item.preferred_tools);
    }
    slots.push(slot);
  }
  return slots.length > 0 ? slots : undefined;
}

/** Parse base FeatureConfig fields from a TOML section object */
function parseFeatureFields(raw: Record<string, unknown>, defaults: FeatureConfig): FeatureConfig {
  const agentSlots = parseAgentSlots(raw.agents);
  return {
    prompt: typeof raw.prompt === 'string' ? raw.prompt : defaults.prompt,
    agentCount: clamp(
      typeof raw.agent_count === 'number' ? raw.agent_count : defaults.agentCount,
      1,
      10,
    ),
    timeout: parseTimeout(raw.timeout ?? defaults.timeout),
    preferredModels: parseStringArray(raw.preferred_models ?? defaults.preferredModels),
    preferredTools: parseStringArray(raw.preferred_tools ?? defaults.preferredTools),
    ...(agentSlots ? { agents: agentSlots } : {}),
  };
}

/** Parse the [review] section from the new .opencara.toml structure */
function parseReviewSection(raw: Record<string, unknown>): ReviewSectionConfig {
  const triggerRaw = isObject(raw.trigger) ? raw.trigger : {};
  const reviewerRaw = isObject(raw.reviewer) ? raw.reviewer : {};

  const base = parseFeatureFields(raw, DEFAULT_FEATURE_CONFIG);

  return {
    ...base,
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
    reviewer: {
      whitelist: parseEntityList(reviewerRaw.whitelist),
      blacklist: parseEntityList(reviewerRaw.blacklist),
    },
    summarizer: parseSummarizerSection(raw.summarizer),
  };
}

const DEFAULT_DEDUP_FEATURE: FeatureConfig = {
  prompt: 'Check for duplicate content.',
  agentCount: 1,
  timeout: '10m',
  preferredModels: [],
  preferredTools: [],
};

/** Parse a dedup target section ([dedup.prs] or [dedup.issues]) */
function parseDedupTarget(raw: Record<string, unknown>): DedupTargetConfig {
  const base = parseFeatureFields(raw, DEFAULT_DEDUP_FEATURE);
  return {
    ...base,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    ...(typeof raw.index_issue === 'number' ? { indexIssue: raw.index_issue } : {}),
  };
}

function parseDedupIssueTarget(raw: Record<string, unknown>): DedupIssueTargetConfig {
  const base = parseDedupTarget(raw);
  return {
    ...base,
    ...(typeof raw.include_closed === 'boolean' ? { includeClosed: raw.include_closed } : {}),
  };
}

/** Parse the [dedup] section */
function parseDedupSection(raw: Record<string, unknown>): DedupConfig {
  const config: DedupConfig = {};
  if (isObject(raw.prs)) config.prs = parseDedupTarget(raw.prs);
  if (isObject(raw.issues)) config.issues = parseDedupIssueTarget(raw.issues);
  return config;
}

const DEFAULT_TRIAGE_FEATURE: FeatureConfig = {
  prompt: 'Triage this issue.',
  agentCount: 1,
  timeout: '10m',
  preferredModels: [],
  preferredTools: [],
};

/** Parse the [triage] section */
function parseTriageSection(raw: Record<string, unknown>): TriageConfig {
  const base = parseFeatureFields(raw, DEFAULT_TRIAGE_FEATURE);

  const defaultMode = raw.default_mode === 'rewrite' ? 'rewrite' : 'comment';

  let authorModes: Record<string, 'comment' | 'rewrite'> | undefined;
  if (isObject(raw.author_modes)) {
    authorModes = {};
    for (const [key, val] of Object.entries(raw.author_modes)) {
      if (val === 'comment' || val === 'rewrite') {
        authorModes[key] = val;
      }
    }
  }

  return {
    ...base,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    defaultMode: defaultMode,
    autoLabel: typeof raw.auto_label === 'boolean' ? raw.auto_label : false,
    triggers: parseStringArray(raw.triggers),
    ...(authorModes ? { authorModes } : {}),
  };
}

/**
 * Parse a .opencara.toml config string into OpenCaraConfig.
 *
 * The new format nests review fields under [review]:
 * ```toml
 * version = 1
 * [review]
 * prompt = "..."
 * agent_count = 3
 * ```
 *
 * For backward compatibility, also supports the legacy flat format where
 * prompt and other fields are at the top level (the old .review.toml format).
 */
export function parseOpenCaraConfig(toml: string): ParseResult {
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

  const config: OpenCaraConfig = { version: raw.version };

  // Detect whether this is new format ([review] section) or legacy flat format
  const hasReviewSection = isObject(raw.review);
  const hasLegacyPrompt = typeof raw.prompt === 'string';

  if (hasReviewSection) {
    // New format: [review] section
    const reviewRaw = raw.review as Record<string, unknown>;
    if (typeof reviewRaw.prompt !== 'string') {
      return { error: 'Missing required field: review.prompt' };
    }
    config.review = parseReviewSection(reviewRaw);
  } else if (hasLegacyPrompt) {
    // Legacy flat format — parse as before (prompt at top level)
    config.review = parseLegacyReviewConfig(raw);
  }
  // If neither, review section is absent (valid — maybe only dedup/triage)

  // Parse optional dedup section
  if (isObject(raw.dedup)) {
    config.dedup = parseDedupSection(raw.dedup);
  }

  // Parse optional triage section
  if (isObject(raw.triage)) {
    config.triage = parseTriageSection(raw.triage);
  }

  return config;
}

/**
 * Parse legacy flat format (the old .review.toml structure).
 * prompt, trigger, agents, reviewer, summarizer, timeout all at top level.
 */
function parseLegacyReviewConfig(raw: Record<string, unknown>): ReviewSectionConfig {
  const triggerRaw = isObject(raw.trigger) ? raw.trigger : {};
  const agentsRaw = isObject(raw.agents) ? raw.agents : {};
  const reviewerRaw = isObject(raw.reviewer) ? raw.reviewer : {};

  return {
    prompt: raw.prompt as string,
    agentCount: clamp(
      typeof agentsRaw.review_count === 'number' ? agentsRaw.review_count : 1,
      1,
      10,
    ),
    timeout: parseTimeout(raw.timeout),
    preferredModels: parseStringArray(agentsRaw.preferred_models),
    preferredTools: parseStringArray(agentsRaw.preferred_tools),
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
    reviewer: {
      whitelist: parseEntityList(reviewerRaw.whitelist),
      blacklist: parseEntityList(reviewerRaw.blacklist),
    },
    summarizer: parseSummarizerSection(raw.summarizer),
  };
}

/** @deprecated Use parseOpenCaraConfig instead */
export function parseReviewConfig(toml: string): ReviewConfig | { error: string } {
  const result = parseOpenCaraConfig(toml);
  if ('error' in result) return result;
  // Return the review section, falling back to defaults
  return result.review ?? DEFAULT_REVIEW_SECTION;
}
