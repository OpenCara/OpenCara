import { parse as parseToml } from 'smol-toml';

export interface TriggerConfig {
  /** PR/issue lifecycle events that auto-trigger (e.g. "opened", "synchronize"). Absent = event triggers disabled. */
  events?: string[];
  /** Comment text that triggers (e.g. "/opencara review"). Absent = comment triggers disabled. */
  comment?: string;
  /** Label name that triggers when added (e.g. "opencara:implement"). Absent = label triggers disabled. */
  label?: string;
  /** GitHub Project board status that triggers when changed to this value (e.g. "Ready"). Absent = status triggers disabled. */
  status?: string;
  /** Labels/conditions that skip triggering (e.g. ["draft"]) */
  skip?: string[];
}

/** An entry in a whitelist/blacklist/preferred list — identifies by agent ID or GitHub username */
export type EntityEntry = { agent?: string; github?: string };

/** Per-agent slot overrides within a feature section */
export interface AgentSlotConfig {
  prompt?: string;
  preferredModels?: string[];
  preferredTools?: string[];
}

/** A named agent definition with required id and prompt */
export interface NamedAgentConfig {
  id: string;
  prompt: string;
  model?: string;
  tool?: string;
}

/** Base config shared by all features (review, dedup, triage) */
export interface FeatureConfig {
  prompt: string;
  agentCount: number;
  timeout: string;
  preferredModels: string[];
  preferredTools: string[];
  agents?: AgentSlotConfig[];
  /** Grace period (ms) for model diversity preference. 0 = disabled. Default: 30000 (30s). */
  modelDiversityGraceMs: number;
}

/** Review section — extends FeatureConfig with trigger and access control */
export interface ReviewSectionConfig extends FeatureConfig {
  trigger: TriggerConfig;
  reviewer: { whitelist: EntityEntry[]; blacklist: EntityEntry[] };
  summarizer: {
    whitelist: EntityEntry[];
    blacklist: EntityEntry[];
    preferred: EntityEntry[];
    preferredModels: string[];
  };
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
  trigger: TriggerConfig;
  defaultMode: 'comment' | 'rewrite';
  autoLabel: boolean;
  authorModes?: Record<string, 'comment' | 'rewrite'>;
}

/** Implement section config */
export interface ImplementConfig extends FeatureConfig {
  enabled: boolean;
  trigger: TriggerConfig;
  agents?: NamedAgentConfig[];
  /** GitHub Project field name whose value maps to a named agent ID */
  agent_field?: string;
}

/** Fix section config */
export interface FixConfig extends FeatureConfig {
  enabled: boolean;
  trigger: TriggerConfig;
  agents?: NamedAgentConfig[];
  /** GitHub Project field name whose value maps to a named agent ID */
  agent_field?: string;
}

/** Issue review section config */
export interface IssueReviewConfig extends FeatureConfig {
  enabled: boolean;
  trigger: TriggerConfig;
}

/** Top-level .opencara.toml config */
export interface OpenCaraConfig {
  version: number;
  review?: ReviewSectionConfig;
  dedup?: DedupConfig;
  triage?: TriageConfig;
  implement?: ImplementConfig;
  fix?: FixConfig;
  issue_review?: IssueReviewConfig;
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
  if (minutes < 1 || minutes > 120) return '10m';
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v: unknown) => typeof v === 'string');
}

/**
 * Parse a [feature.trigger] section, merging with per-feature defaults.
 *
 * - If a field is absent in TOML → use the default value
 * - If a field is `false` → explicitly disabled (field omitted from result)
 * - `on` is accepted as an alias for `events` (backward compatibility)
 */
export function parseTriggerSection(
  raw: Record<string, unknown> | undefined,
  defaults: TriggerConfig,
): TriggerConfig {
  if (!raw) return { ...defaults };

  const result: TriggerConfig = {};

  // events (accept `on` as alias for backward compat)
  const eventsRaw = raw.events !== undefined ? raw.events : raw.on;
  if (eventsRaw === false) {
    // explicitly disabled — omit events
  } else if (Array.isArray(eventsRaw)) {
    result.events = eventsRaw.filter((v: unknown) => typeof v === 'string');
  } else if (defaults.events !== undefined) {
    result.events = defaults.events;
  }

  // comment
  if (raw.comment === false) {
    // explicitly disabled
  } else if (typeof raw.comment === 'string') {
    result.comment = raw.comment;
  } else if (defaults.comment !== undefined) {
    result.comment = defaults.comment;
  }

  // label
  if (raw.label === false) {
    // explicitly disabled
  } else if (typeof raw.label === 'string') {
    result.label = raw.label;
  } else if (defaults.label !== undefined) {
    result.label = defaults.label;
  }

  // status
  if (raw.status === false) {
    // explicitly disabled
  } else if (typeof raw.status === 'string') {
    result.status = raw.status;
  } else if (defaults.status !== undefined) {
    result.status = defaults.status;
  }

  // skip
  if (Array.isArray(raw.skip)) {
    result.skip = raw.skip.filter((v: unknown) => typeof v === 'string');
  } else if (defaults.skip !== undefined) {
    result.skip = defaults.skip;
  }

  return result;
}

/** Check if event-based triggers are enabled */
export function isEventTriggerEnabled(trigger: TriggerConfig): boolean {
  return trigger.events !== undefined && trigger.events.length > 0;
}

/** Check if comment-based triggers are enabled */
export function isCommentTriggerEnabled(trigger: TriggerConfig): boolean {
  return trigger.comment !== undefined;
}

/** Check if label-based triggers are enabled */
export function isLabelTriggerEnabled(trigger: TriggerConfig): boolean {
  return trigger.label !== undefined;
}

/** Check if status-based triggers are enabled */
export function isStatusTriggerEnabled(trigger: TriggerConfig): boolean {
  return trigger.status !== undefined;
}

/** Default model diversity grace period: 30 seconds */
export const DEFAULT_MODEL_DIVERSITY_GRACE_MS = 30_000;

/**
 * Parse a duration string like "30s" or "60s" into milliseconds.
 * Supports seconds ("Ns") only. Returns default if invalid. 0 disables.
 * Numeric input is interpreted as seconds (e.g., 30 → 30000ms).
 */
function parseDurationSeconds(value: unknown, defaultMs: number): number {
  if (typeof value === 'number') return value === 0 ? 0 : clamp(value, 0, 300) * 1000;
  if (typeof value !== 'string') return defaultMs;
  if (value === '0' || value === '0s') return 0;
  const match = value.match(/^(\d+)s$/);
  if (!match) return defaultMs;
  const seconds = parseInt(match[1], 10);
  return clamp(seconds, 0, 300) * 1000; // max 5 minutes
}

export function validateReviewConfig(config: unknown): config is ReviewConfig {
  if (!isObject(config)) return false;
  if (typeof config.prompt !== 'string') return false;
  return true;
}

/** Validate an OpenCaraConfig — requires version (all feature sections are optional) */
export function validateOpenCaraConfig(config: unknown): config is OpenCaraConfig {
  if (!isObject(config)) return false;
  if (typeof config.version !== 'number') return false;
  return true;
}

/**
 * Default review configuration used when .opencara.toml is not present in the repo.
 */
/** Default trigger config for review feature */
export const DEFAULT_REVIEW_TRIGGER: TriggerConfig = {
  events: ['opened'],
  comment: '/opencara review',
  skip: ['draft'],
};

/** Default trigger config for implement feature */
export const DEFAULT_IMPLEMENT_TRIGGER: TriggerConfig = {
  comment: '/opencara go',
  status: 'Ready',
};

/** Default trigger config for fix feature */
export const DEFAULT_FIX_TRIGGER: TriggerConfig = {
  comment: '/opencara fix',
};

/** Default trigger config for triage feature */
export const DEFAULT_TRIAGE_TRIGGER: TriggerConfig = {
  events: ['opened'],
  comment: '/opencara triage',
};

/** Default trigger config for issue review feature */
export const DEFAULT_ISSUE_REVIEW_TRIGGER: TriggerConfig = {
  comment: '/opencara review-issue',
};

/** @deprecated Use DEFAULT_REVIEW_TRIGGER instead */
const DEFAULT_TRIGGER = DEFAULT_REVIEW_TRIGGER;

const DEFAULT_FEATURE_CONFIG: FeatureConfig = {
  prompt: 'Review this pull request for bugs, security issues, and code quality.',
  agentCount: 1,
  timeout: '10m',
  preferredModels: [],
  preferredTools: [],
  modelDiversityGraceMs: DEFAULT_MODEL_DIVERSITY_GRACE_MS,
};

export const DEFAULT_REVIEW_SECTION: ReviewSectionConfig = {
  ...DEFAULT_FEATURE_CONFIG,
  trigger: DEFAULT_TRIGGER,
  reviewer: { whitelist: [], blacklist: [] },
  summarizer: { whitelist: [], blacklist: [], preferred: [], preferredModels: [] },
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
    preferredModels: [],
  };

  // String shorthand: "alice" → preferred with github username
  if (typeof raw === 'string') {
    return { ...defaults, preferred: [toGithubEntity(raw)] };
  }

  if (!isObject(raw)) return defaults;

  // Parse preferred_models from any object form
  const preferredModels = parseStringArray(raw.preferred_models);

  // Object with "only" key — whitelist-only mode
  if (raw.only !== undefined) {
    if (typeof raw.only === 'string') {
      return { ...defaults, whitelist: [toGithubEntity(raw.only)], preferredModels };
    }
    if (Array.isArray(raw.only)) {
      const entries = raw.only
        .filter((v: unknown) => typeof v === 'string')
        .map((v: unknown) => toGithubEntity(v as string));
      return { ...defaults, whitelist: entries, preferredModels };
    }
    return { ...defaults, preferredModels };
  }

  // Full object (existing behavior)
  return {
    whitelist: parseEntityList(raw.whitelist),
    blacklist: parseEntityList(raw.blacklist),
    preferred: parseEntityList(raw.preferred),
    preferredModels,
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

/** Parse [[implement.agents]] array into NamedAgentConfig[] (requires id + prompt) */
function parseNamedAgents(value: unknown): NamedAgentConfig[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const agents: NamedAgentConfig[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    if (typeof item.id !== 'string' || typeof item.prompt !== 'string') continue;
    const agent: NamedAgentConfig = { id: item.id, prompt: item.prompt };
    if (typeof item.model === 'string') agent.model = item.model;
    if (typeof item.tool === 'string') agent.tool = item.tool;
    agents.push(agent);
  }
  return agents.length > 0 ? agents : undefined;
}

/**
 * Look up a named agent by ID in a config with named agents.
 * Works with ImplementConfig, FixConfig, or any config with agents.
 * Returns undefined if not found.
 */
export function resolveNamedAgent(
  config: { agents?: NamedAgentConfig[] },
  agentId: string,
): NamedAgentConfig | undefined {
  return config.agents?.find((a) => a.id === agentId);
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
    modelDiversityGraceMs: parseDurationSeconds(
      raw.model_diversity_grace,
      defaults.modelDiversityGraceMs,
    ),
    ...(agentSlots ? { agents: agentSlots } : {}),
  };
}

/** Parse the [review] section from the new .opencara.toml structure */
function parseReviewSection(raw: Record<string, unknown>): ReviewSectionConfig {
  const triggerRaw = isObject(raw.trigger) ? raw.trigger : undefined;
  const reviewerRaw = isObject(raw.reviewer) ? raw.reviewer : {};

  const base = parseFeatureFields(raw, DEFAULT_FEATURE_CONFIG);

  return {
    ...base,
    trigger: parseTriggerSection(triggerRaw, DEFAULT_REVIEW_TRIGGER),
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
  modelDiversityGraceMs: DEFAULT_MODEL_DIVERSITY_GRACE_MS,
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
  modelDiversityGraceMs: DEFAULT_MODEL_DIVERSITY_GRACE_MS,
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

  // Backward compat: if no [triage.trigger] section but old `triggers` array exists,
  // convert it to trigger.events
  const triggerRaw = isObject(raw.trigger) ? raw.trigger : undefined;
  let triageDefaults = DEFAULT_TRIAGE_TRIGGER;
  if (!triggerRaw && Array.isArray(raw.triggers)) {
    triageDefaults = { ...DEFAULT_TRIAGE_TRIGGER, events: parseStringArray(raw.triggers) };
  }

  return {
    ...base,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    trigger: parseTriggerSection(triggerRaw, triageDefaults),
    defaultMode: defaultMode,
    autoLabel: typeof raw.auto_label === 'boolean' ? raw.auto_label : false,
    ...(authorModes ? { authorModes } : {}),
  };
}

const DEFAULT_IMPLEMENT_FEATURE: FeatureConfig = {
  prompt: 'Implement the requested changes.',
  agentCount: 1,
  timeout: '10m',
  preferredModels: [],
  preferredTools: [],
  modelDiversityGraceMs: DEFAULT_MODEL_DIVERSITY_GRACE_MS,
};

/** Parse the [implement] section */
function parseImplementSection(raw: Record<string, unknown>): ImplementConfig {
  const { agents: _slots, ...base } = parseFeatureFields(raw, DEFAULT_IMPLEMENT_FEATURE);
  const triggerRaw = isObject(raw.trigger) ? raw.trigger : undefined;
  const namedAgents = parseNamedAgents(raw.agents);
  const agentField = typeof raw.agent_field === 'string' ? raw.agent_field : undefined;
  return {
    ...base,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    trigger: parseTriggerSection(triggerRaw, DEFAULT_IMPLEMENT_TRIGGER),
    ...(namedAgents ? { agents: namedAgents } : {}),
    ...(agentField ? { agent_field: agentField } : {}),
  };
}

const DEFAULT_FIX_FEATURE: FeatureConfig = {
  prompt: 'Fix the review comments.',
  agentCount: 1,
  timeout: '10m',
  preferredModels: [],
  preferredTools: [],
  modelDiversityGraceMs: DEFAULT_MODEL_DIVERSITY_GRACE_MS,
};

/** Parse the [fix] section */
function parseFixSection(raw: Record<string, unknown>): FixConfig {
  const { agents: _slots, ...base } = parseFeatureFields(raw, DEFAULT_FIX_FEATURE);
  const triggerRaw = isObject(raw.trigger) ? raw.trigger : undefined;
  const namedAgents = parseNamedAgents(raw.agents);
  const agentField = typeof raw.agent_field === 'string' ? raw.agent_field : undefined;
  return {
    ...base,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    trigger: parseTriggerSection(triggerRaw, DEFAULT_FIX_TRIGGER),
    ...(namedAgents ? { agents: namedAgents } : {}),
    ...(agentField ? { agent_field: agentField } : {}),
  };
}

const DEFAULT_ISSUE_REVIEW_FEATURE: FeatureConfig = {
  prompt: 'Review this issue for clarity, completeness, and actionability.',
  agentCount: 2,
  timeout: '5m',
  preferredModels: [],
  preferredTools: [],
  modelDiversityGraceMs: DEFAULT_MODEL_DIVERSITY_GRACE_MS,
};

/** Parse the [issue_review] section */
function parseIssueReviewSection(raw: Record<string, unknown>): IssueReviewConfig {
  const base = parseFeatureFields(raw, DEFAULT_ISSUE_REVIEW_FEATURE);
  const triggerRaw = isObject(raw.trigger) ? raw.trigger : undefined;
  return {
    ...base,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    trigger: parseTriggerSection(triggerRaw, DEFAULT_ISSUE_REVIEW_TRIGGER),
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

  // Parse optional implement section
  if (isObject(raw.implement)) {
    config.implement = parseImplementSection(raw.implement);
  }

  // Parse optional fix section
  if (isObject(raw.fix)) {
    config.fix = parseFixSection(raw.fix);
  }

  // Parse optional issue_review section
  if (isObject(raw.issue_review)) {
    config.issue_review = parseIssueReviewSection(raw.issue_review);
  }

  return config;
}

/**
 * Parse legacy flat format (the old .review.toml structure).
 * prompt, trigger, agents, reviewer, summarizer, timeout all at top level.
 */
function parseLegacyReviewConfig(raw: Record<string, unknown>): ReviewSectionConfig {
  const triggerRaw = isObject(raw.trigger) ? raw.trigger : undefined;
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
    modelDiversityGraceMs: parseDurationSeconds(
      raw.model_diversity_grace ?? agentsRaw.model_diversity_grace,
      DEFAULT_MODEL_DIVERSITY_GRACE_MS,
    ),
    trigger: parseTriggerSection(triggerRaw, DEFAULT_REVIEW_TRIGGER),
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
