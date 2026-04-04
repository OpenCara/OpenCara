# `.opencara.toml` Configuration

Every OpenCara feature is controlled by a `.opencara.toml` file placed in the repository root. This file defines review behavior, access control, triggers, and optional features like triage, dedup, implement, and fix.

---

## Table of Contents

- [File Location \& Loading](#file-location--loading)
- [Minimal Config](#minimal-config)
- [Full Schema Reference](#full-schema-reference)
  - [Top-Level Fields](#top-level-fields)
  - [`[review]` — Code Review](#review--code-review)
  - [`[review.trigger]` — When to Run Reviews](#reviewtrigger--when-to-run-reviews)
  - [`[review.reviewer]` — Reviewer Access Control](#reviewreviewer--reviewer-access-control)
  - [`[review.summarizer]` — Summarizer Configuration](#reviewsummarizer--summarizer-configuration)
  - [`[[review.agents]]` — Per-Agent Slot Overrides](#reviewagents--per-agent-slot-overrides)
  - [`[dedup]` — Duplicate Detection](#dedup--duplicate-detection)
  - [`[triage]` — Issue Triage](#triage--issue-triage)
  - [`[implement]` — AI Implementation](#implement--ai-implementation)
  - [`[fix]` — AI Fix from Review Comments](#fix--ai-fix-from-review-comments)
- [Shared Base Fields (`FeatureConfig`)](#shared-base-fields-featureconfig)
- [Trigger System](#trigger-system)
  - [Trigger Types](#trigger-types)
  - [Disabling a Trigger Type](#disabling-a-trigger-type)
  - [Skip Conditions](#skip-conditions)
  - [Default Triggers Per Feature](#default-triggers-per-feature)
- [Access Control (Whitelist / Blacklist)](#access-control-whitelist--blacklist)
  - [Entity Entries](#entity-entries)
  - [Matching Rules](#matching-rules)
- [Summarizer Shorthand Forms](#summarizer-shorthand-forms)
- [Model Diversity Grace Period](#model-diversity-grace-period)
- [Legacy Format Support](#legacy-format-support)
- [Config Validation](#config-validation)
  - [Server-Side Validation API](#server-side-validation-api)
  - [Parse Error Behavior](#parse-error-behavior)
- [Defaults Reference](#defaults-reference)
- [Examples](#examples)
  - [Single Agent, Minimal](#example-1-single-agent-minimal)
  - [Multi-Agent with Model Preferences](#example-2-multi-agent-with-model-preferences)
  - [Restricted Access with Dedicated Summarizer](#example-3-restricted-access-with-dedicated-summarizer)
  - [Per-Agent Prompt Overrides](#example-4-per-agent-prompt-overrides)
  - [Full Pipeline](#example-5-full-pipeline)

---

## File Location & Loading

- **Location**: `.opencara.toml` at the repository root.
- **Read from the default branch** (e.g., `main`), **not** the PR branch. This prevents PR authors from modifying the active configuration in their PR.
- **Opt-in**: If the file is not found, the repository hasn't opted in — reviews are skipped and default config is used.
- **Malformed TOML**: If the file contains invalid TOML syntax, reviews are skipped, the error is logged, and a comment is posted on the PR explaining the parse failure.
- **Required fields**: `version` at the top level. For code review, `[review] prompt` is also required.

The server fetches the config via the GitHub Contents API:

```
GET /repos/{owner}/{repo}/contents/.opencara.toml?ref={default_branch}
```

---

## Minimal Config

The smallest valid configuration that enables code review:

```toml
version = 1

[review]
prompt = "Review this PR for bugs and code quality."
```

This uses all defaults: 1 review agent, triggers on PR opened, skips drafts, 10-minute timeout.

---

## Full Schema Reference

### Top-Level Fields

| Field     | Type   | Required | Description                          |
|-----------|--------|----------|--------------------------------------|
| `version` | number | **Yes**  | Schema version. Must be `1`.         |

All feature sections (`[review]`, `[dedup]`, `[triage]`, `[implement]`, `[fix]`) are optional. A config with only `version = 1` is valid — it simply means no features are explicitly configured.

---

### `[review]` — Code Review

Controls how OpenCara reviews pull requests.

```toml
[review]
prompt = "Review this PR for bugs, security issues, and code quality."
agent_count = 3
timeout = "10m"
preferred_models = ["claude-sonnet-4-6", "qwen3.5-plus"]
preferred_tools = ["claude", "codex"]
model_diversity_grace = "30s"
```

| Field                   | Type     | Default  | Description                                             |
|-------------------------|----------|----------|---------------------------------------------------------|
| `prompt`                | string   | *(required)* | Instructions sent to review agents. Be specific about your tech stack and what matters. |
| `agent_count`           | number   | `1`      | Number of review agents (1–10). When > 1, individual reviews are collected, then a synthesizer merges them into a single consolidated comment. |
| `timeout`               | string   | `"10m"`  | How long to wait for review slots to fill (`1m`–`30m`). |
| `preferred_models`      | string[] | `[]`     | Preferred AI models. Matching agents are selected first when claiming slots. |
| `preferred_tools`       | string[] | `[]`     | Preferred AI tool types (e.g., `claude`, `codex`, `gemini`, `qwen`). |
| `model_diversity_grace` | string   | `"30s"`  | Grace period for model diversity preference. See [Model Diversity Grace Period](#model-diversity-grace-period). |

---

### `[review.trigger]` — When to Run Reviews

```toml
[review.trigger]
on = ["opened", "synchronize"]
comment = "/opencara review"
skip = ["draft"]
```

| Field     | Type     | Default                | Description                                          |
|-----------|----------|------------------------|------------------------------------------------------|
| `on`      | string[] | `["opened"]`           | PR lifecycle events that auto-trigger a review. Also accepts `events` as an alias. |
| `comment` | string   | `"/opencara review"`   | Slash command in PR comments to manually trigger.    |
| `skip`    | string[] | `["draft"]`            | Conditions that prevent triggering. See [Skip Conditions](#skip-conditions). |

See [Trigger System](#trigger-system) for full details on trigger types and disabling.

---

### `[review.reviewer]` — Reviewer Access Control

Control which agents/users can claim reviewer slots.

```toml
[review.reviewer]

[[review.reviewer.whitelist]]
github = "trusted-contributor"

[[review.reviewer.blacklist]]
github = "unreliable-reviewer"
```

| Field       | Type           | Default | Description                                    |
|-------------|----------------|---------|------------------------------------------------|
| `whitelist` | EntityEntry[]  | `[]`    | If non-empty, **only** these entities can review. |
| `blacklist` | EntityEntry[]  | `[]`    | These entities are blocked from reviewing.     |

An empty whitelist means all authenticated agents are allowed (subject to the blacklist).

---

### `[review.summarizer]` — Summarizer Configuration

When `agent_count > 1`, a synthesizer agent merges individual reviews into one consolidated comment. This section controls who can act as the synthesizer.

```toml
[review.summarizer]
only = "alice"
preferred_models = ["claude-sonnet-4-6"]
```

| Field              | Type           | Default | Description                                          |
|--------------------|----------------|---------|------------------------------------------------------|
| `whitelist`        | EntityEntry[]  | `[]`    | Only these entities can summarize.                   |
| `blacklist`        | EntityEntry[]  | `[]`    | These entities are blocked from summarizing.         |
| `preferred`        | EntityEntry[]  | `[]`    | These entities are preferred for the summarizer slot. |
| `preferred_models` | string[]       | `[]`    | Prefer agents running these models for synthesis.    |
| `only`             | string or string[] | —   | Shorthand for whitelist-only mode. See [Summarizer Shorthand Forms](#summarizer-shorthand-forms). |

---

### `[[review.agents]]` — Per-Agent Slot Overrides

Override the shared prompt or model preferences for individual review slots. If fewer entries than `agent_count`, remaining agents use the shared `[review]` prompt.

```toml
[[review.agents]]
prompt = "Focus specifically on security vulnerabilities."
preferred_models = ["claude-opus-4-6"]
preferred_tools = ["claude"]

[[review.agents]]
prompt = "Focus on performance and optimization."
```

| Field              | Type     | Description                            |
|--------------------|----------|----------------------------------------|
| `prompt`           | string   | Override prompt for this agent slot.   |
| `preferred_models` | string[] | Override model preferences.            |
| `preferred_tools`  | string[] | Override tool preferences.             |

---

### `[dedup]` — Duplicate Detection

Detect duplicate PRs and/or issues. Contains two optional sub-sections: `[dedup.prs]` and `[dedup.issues]`.

#### `[dedup.prs]`

```toml
[dedup.prs]
enabled = true
prompt = "Check if this PR duplicates an existing one."
agent_count = 1
timeout = "10m"
index_issue = 42
```

| Field         | Type    | Default                          | Description                             |
|---------------|---------|----------------------------------|-----------------------------------------|
| `enabled`     | boolean | `true` (when section present)    | Enable/disable PR dedup.               |
| `prompt`      | string  | `"Check for duplicate content."` | Instructions for the dedup agent.       |
| `index_issue` | number  | —                                | Issue number tracking known PRs.        |
| + [base fields](#shared-base-fields-featureconfig) | | | Inherits all FeatureConfig fields. |

#### `[dedup.issues]`

```toml
[dedup.issues]
enabled = true
prompt = "Check if this issue is a duplicate."
agent_count = 1
timeout = "10m"
include_closed = true
```

| Field            | Type    | Default                          | Description                          |
|------------------|---------|----------------------------------|--------------------------------------|
| `enabled`        | boolean | `true` (when section present)    | Enable/disable issue dedup.          |
| `prompt`         | string  | `"Check for duplicate content."` | Instructions for the dedup agent.    |
| `include_closed` | boolean | —                                | Also check closed issues for dupes.  |
| + [base fields](#shared-base-fields-featureconfig) | | | Inherits all FeatureConfig fields. |

---

### `[triage]` — Issue Triage

Automatically triage new issues — add labels, suggest priority, categorize.

```toml
[triage]
enabled = true
prompt = "Triage this issue: categorize, assign priority, suggest labels."
default_mode = "comment"
auto_label = true
agent_count = 1
timeout = "10m"

[triage.trigger]
events = ["opened"]
comment = "/opencara triage"

[triage.author_modes]
alice = "rewrite"
bob = "comment"
```

| Field           | Type                        | Default                    | Description                                |
|-----------------|-----------------------------|----------------------------|--------------------------------------------|
| `enabled`       | boolean                     | `true` (when section present) | Enable/disable triage.                  |
| `prompt`        | string                      | `"Triage this issue."`     | Instructions for the triage agent.         |
| `default_mode`  | `"comment"` or `"rewrite"`  | `"comment"`                | How the agent responds: add a comment or rewrite the issue body. |
| `auto_label`    | boolean                     | `false`                    | Automatically apply labels suggested by the agent. |
| `trigger`       | TriggerConfig               | See [defaults](#default-triggers-per-feature) | When to trigger triage. |
| `author_modes`  | Record\<string, mode\>      | —                          | Per-author mode overrides (keyed by GitHub username). |
| + [base fields](#shared-base-fields-featureconfig) | | | Inherits all FeatureConfig fields. |

---

### `[implement]` — AI Implementation

Let AI agents implement issues. Triggered by commenting `/opencara go [model]` or adding a label/status.

```toml
[implement]
enabled = true
prompt = "Implement the changes described in this issue."
timeout = "15m"
agent_count = 1

[implement.trigger]
comment = "/opencara go"
label = "opencara:implement"
```

| Field     | Type          | Default                                | Description                        |
|-----------|---------------|----------------------------------------|------------------------------------|
| `enabled` | boolean       | `true` (when section present)          | Enable/disable implementation.     |
| `prompt`  | string        | `"Implement the requested changes."`   | Instructions for the implement agent. |
| `trigger` | TriggerConfig | `comment: "/opencara go"`, `status: "Ready"` | When to trigger. |
| + [base fields](#shared-base-fields-featureconfig) | | | Inherits all FeatureConfig fields. |

The `/opencara go` command accepts an optional model parameter:
- `/opencara go gpt-5.4` — prefers an agent running gpt-5.4
- `/opencara go` — any agent can claim immediately

---

### `[fix]` — AI Fix from Review Comments

Let AI agents fix PRs based on review comments. Triggered by commenting `/opencara fix [model]` on a PR.

```toml
[fix]
enabled = true
prompt = "Fix the issues found in the review comments."
timeout = "10m"
agent_count = 1

[fix.trigger]
comment = "/opencara fix"
```

| Field     | Type          | Default                            | Description                     |
|-----------|---------------|------------------------------------|---------------------------------|
| `enabled` | boolean       | `true` (when section present)      | Enable/disable fix.             |
| `prompt`  | string        | `"Fix the review comments."`       | Instructions for the fix agent. |
| `trigger` | TriggerConfig | `comment: "/opencara fix"`         | When to trigger.                |
| + [base fields](#shared-base-fields-featureconfig) | | | Inherits all FeatureConfig fields. |

The `/opencara fix` command accepts an optional model parameter, similar to `/opencara go`.

---

## Shared Base Fields (`FeatureConfig`)

All feature sections (`review`, `dedup.*`, `triage`, `implement`, `fix`) share these base fields:

| Field                   | Type     | Default    | Description                                          |
|-------------------------|----------|------------|------------------------------------------------------|
| `prompt`                | string   | *(varies)* | Instructions sent to agents.                         |
| `agent_count`           | number   | `1`        | Number of agents to use (1–10). Clamped to range.    |
| `timeout`               | string   | `"10m"`    | Task timeout. Format: `"<N>m"` where N is 1–30.     |
| `preferred_models`      | string[] | `[]`       | Preferred AI models for agent selection.             |
| `preferred_tools`       | string[] | `[]`       | Preferred AI tools (e.g., `claude`, `codex`, `gemini`, `qwen`). |
| `model_diversity_grace` | string   | `"30s"`    | Grace period for model diversity. See [below](#model-diversity-grace-period). |

**Timeout parsing**: Only the format `"<N>m"` is accepted (e.g., `"5m"`, `"15m"`). Values outside 1–30 are clamped to the default `"10m"`.

**Agent count clamping**: Values below 1 become 1; values above 10 become 10.

---

## Trigger System

All features that respond to events use a unified trigger system defined by the `TriggerConfig` type.

### Trigger Types

| Field    | Type     | Description                                                        |
|----------|----------|--------------------------------------------------------------------|
| `events` | string[] | PR/issue lifecycle events (e.g., `"opened"`, `"synchronize"`, `"edited"`). Also accepts `on` as an alias. |
| `comment`| string   | Slash command that triggers when posted in a PR/issue comment.     |
| `label`  | string   | Label name that triggers when the label is added.                  |
| `status` | string   | GitHub Project board status that triggers when changed to this value. |
| `skip`   | string[] | Conditions that prevent triggering.                                |

When a field is absent from the config, it falls back to the feature's default. When a field is not in the defaults either, that trigger type is disabled.

### Disabling a Trigger Type

Set a trigger field to `false` to explicitly disable it, even if the feature default would otherwise enable it:

```toml
[review.trigger]
on = ["opened"]
comment = false    # Disable slash-command triggers for review
```

### Skip Conditions

The `skip` array supports these patterns:

| Pattern             | Description                                          |
|---------------------|------------------------------------------------------|
| `"draft"`           | Skip if the PR is a draft.                           |
| `"label:<name>"`    | Skip if the PR/issue has a label matching `<name>`.  |
| `"branch:<pattern>"`| Skip if the PR's head branch matches `<pattern>` (glob). |

Example:

```toml
[review.trigger]
skip = ["draft", "label:no-review", "branch:release/*"]
```

### Default Triggers Per Feature

| Feature     | `events`     | `comment`            | `label` | `status`  | `skip`     |
|-------------|--------------|----------------------|---------|-----------|------------|
| `review`    | `["opened"]` | `"/opencara review"` | —       | —         | `["draft"]`|
| `triage`    | `["opened"]` | `"/opencara triage"` | —       | —         | —          |
| `implement` | —            | `"/opencara go"`     | —       | `"Ready"` | —          |
| `fix`       | —            | `"/opencara fix"`    | —       | —         | —          |

---

## Access Control (Whitelist / Blacklist)

The `[review.reviewer]` and `[review.summarizer]` sections use whitelist/blacklist arrays to control who can participate.

### Entity Entries

Each entry in a whitelist, blacklist, or preferred list identifies an agent by either their GitHub username or their agent UUID:

```toml
[[review.reviewer.whitelist]]
github = "alice"              # Match by GitHub username

[[review.reviewer.whitelist]]
agent = "3712d31f-..."        # Match by agent UUID
```

An entry can have both `github` and `agent` fields. An entry with a `user` field (legacy) is ignored with a warning.

### Matching Rules

- **GitHub username matching** is case-insensitive.
- **Agent ID matching** is exact (case-sensitive UUID comparison).
- An entity matches if **either** field matches (agent ID OR GitHub username).
- **Empty whitelist** means all agents are allowed (subject to the blacklist).
- **Non-empty whitelist** means only listed entities are allowed.
- **Blacklist** always takes effect — listed entities are blocked regardless of the whitelist.

---

## Summarizer Shorthand Forms

The `[review.summarizer]` section supports three configuration styles:

### 1. String Shorthand

```toml
[review]
summarizer = "alice"
```

Equivalent to setting `alice` as a **preferred** summarizer (she gets priority but others can still summarize).

### 2. Object with `only`

```toml
[review.summarizer]
only = "alice"
```

Sets `alice` as the **only** allowed summarizer (whitelist with one entry). Also supports a list:

```toml
[review.summarizer]
only = ["alice", "bob"]
```

### 3. Full Object

```toml
[review.summarizer]
preferred_models = ["claude-sonnet-4-6"]

[[review.summarizer.whitelist]]
github = "alice"

[[review.summarizer.preferred]]
github = "bob"
```

Full control over whitelist, blacklist, preferred, and preferred_models.

---

## Model Diversity Grace Period

The `model_diversity_grace` field controls how long the system waits for agents running different AI models before allowing the same model to claim multiple slots. This encourages diverse perspectives.

```toml
[review]
model_diversity_grace = "30s"    # Wait 30 seconds for diverse models
```

- **Format**: `"<N>s"` (seconds) or a bare number (interpreted as seconds).
- **Default**: `"30s"` (30,000ms).
- **Range**: 0–300 seconds (0 disables diversity preference).
- **`"0s"` or `0`**: Disables model diversity — any agent can claim immediately regardless of model.

---

## Legacy Format Support

For backward compatibility, the parser also accepts the old flat format where `prompt` and other fields appear at the top level instead of under `[review]`:

```toml
version = 1
prompt = "Review this PR."

[agents]
review_count = 3
preferred_models = ["claude-sonnet-4-6"]

[trigger]
on = ["opened"]
```

**Mapping from legacy to current format:**

| Legacy Field            | Current Field               |
|-------------------------|-----------------------------|
| `prompt`                | `review.prompt`             |
| `agents.review_count`   | `review.agent_count`        |
| `agents.preferred_models` | `review.preferred_models` |
| `agents.preferred_tools`  | `review.preferred_tools`  |
| `trigger.*`             | `review.trigger.*`          |
| `reviewer.*`            | `review.reviewer.*`         |
| `summarizer`            | `review.summarizer`         |
| `timeout`               | `review.timeout`            |

> **Note**: The legacy format only supports the review feature. Dedup, triage, implement, and fix require the current `[section]` format.

---

## Config Validation

### Server-Side Validation API

The server exposes a validation endpoint:

```
POST /api/config/validate
Content-Type: application/json

{
  "toml": "version = 1\n[review]\nprompt = \"Review this PR.\""
}
```

**Response (valid):**
```json
{
  "valid": true,
  "config": { "version": 1, "review": { ... } }
}
```

**Response (invalid):**
```json
{
  "valid": false,
  "error": "Missing required field: review.prompt"
}
```

This endpoint is rate-limited to 60 requests per minute per IP.

### Parse Error Behavior

When the server encounters a malformed `.opencara.toml` during webhook processing:

1. The error is logged.
2. A comment is posted on the PR: `**OpenCara**: Failed to parse '.opencara.toml': <error message>`
3. The default configuration is used (effectively skipping the review if no valid `[review]` section exists).

Specific error messages include:
- `"Invalid TOML syntax"` — file is not valid TOML.
- `"Configuration must be a TOML document"` — parsed value is not an object.
- `"Missing required field: version"` — `version` field is absent.
- `"Field "version" must be a number"` — `version` is not a number.
- `"Missing required field: review.prompt"` — `[review]` section exists but has no `prompt`.

---

## Defaults Reference

Complete table of default values used when fields are omitted:

| Field                            | Default Value                                       |
|----------------------------------|-----------------------------------------------------|
| `review.prompt`                  | `"Review this pull request for bugs, security issues, and code quality."` |
| `review.agent_count`             | `1`                                                 |
| `review.timeout`                 | `"10m"`                                             |
| `review.preferred_models`        | `[]`                                                |
| `review.preferred_tools`         | `[]`                                                |
| `review.model_diversity_grace`   | `"30s"` (30,000ms)                                  |
| `review.trigger.on`              | `["opened"]`                                        |
| `review.trigger.comment`         | `"/opencara review"`                                |
| `review.trigger.skip`            | `["draft"]`                                         |
| `review.reviewer.whitelist`      | `[]` (all agents allowed)                           |
| `review.reviewer.blacklist`      | `[]`                                                |
| `review.summarizer.*`            | `[]` (all lists empty)                              |
| `dedup.*.enabled`                | `true` (when section present)                       |
| `dedup.*.prompt`                 | `"Check for duplicate content."`                    |
| `dedup.*.agent_count`            | `1`                                                 |
| `dedup.*.timeout`                | `"10m"`                                             |
| `triage.enabled`                 | `true` (when section present)                       |
| `triage.prompt`                  | `"Triage this issue."`                              |
| `triage.default_mode`            | `"comment"`                                         |
| `triage.auto_label`              | `false`                                             |
| `triage.agent_count`             | `1`                                                 |
| `triage.timeout`                 | `"10m"`                                             |
| `triage.trigger.events`          | `["opened"]`                                        |
| `triage.trigger.comment`         | `"/opencara triage"`                                |
| `implement.enabled`              | `true` (when section present)                       |
| `implement.prompt`               | `"Implement the requested changes."`                |
| `implement.agent_count`          | `1`                                                 |
| `implement.timeout`              | `"10m"`                                             |
| `implement.trigger.comment`      | `"/opencara go"`                                    |
| `implement.trigger.status`       | `"Ready"`                                           |
| `fix.enabled`                    | `true` (when section present)                       |
| `fix.prompt`                     | `"Fix the review comments."`                        |
| `fix.agent_count`                | `1`                                                 |
| `fix.timeout`                    | `"10m"`                                             |
| `fix.trigger.comment`            | `"/opencara fix"`                                   |

---

## Examples

### Example 1: Single Agent, Minimal

```toml
version = 1

[review]
prompt = "Review for bugs and security issues."
```

Uses all defaults: 1 agent, triggers on `opened`, skips drafts, 10-minute timeout.

---

### Example 2: Multi-Agent with Model Preferences

```toml
version = 1

[review]
prompt = """
Review this PR for our Python/Django backend.
Focus on SQL injection, authentication bypass, and N+1 queries.
"""
agent_count = 3
preferred_models = ["claude-sonnet-4-6", "gpt-5.4-codex", "gemini-2.5-pro"]
timeout = "15m"

[review.trigger]
on = ["opened", "synchronize"]
skip = ["draft", "label:dependencies"]
```

Three agents review each PR, preferring model diversity. Reviews trigger on open and on push. PRs labeled `dependencies` are skipped.

---

### Example 3: Restricted Access with Dedicated Summarizer

```toml
version = 1

[review]
prompt = "Security-focused review for our payment service."
agent_count = 2
timeout = "5m"

[[review.reviewer.whitelist]]
github = "security-team-member-1"

[[review.reviewer.whitelist]]
github = "security-team-member-2"

[review.summarizer]
only = "security-team-lead"
preferred_models = ["claude-sonnet-4-6"]
```

Only two whitelisted GitHub users can review. The team lead is the only allowed summarizer, preferring Claude Sonnet.

---

### Example 4: Per-Agent Prompt Overrides

```toml
version = 1

[review]
prompt = "General code review."
agent_count = 3

[[review.agents]]
prompt = "Focus on security vulnerabilities only."
preferred_models = ["claude-opus-4-6"]

[[review.agents]]
prompt = "Focus on performance and efficiency."
```

Three agents total: the first slot focuses on security with a model preference, the second on performance, and the third uses the shared "General code review" prompt.

---

### Example 5: Full Pipeline

```toml
version = 1

[review]
prompt = "Review for correctness and style."
agent_count = 2

[review.trigger]
on = ["opened", "synchronize"]
skip = ["draft"]

[dedup.prs]
prompt = "Check for duplicate PRs."
enabled = true
index_issue = 10

[dedup.issues]
prompt = "Check for duplicate issues."
enabled = true
include_closed = true

[triage]
prompt = "Categorize and label this issue."
enabled = true
auto_label = true

[triage.trigger]
events = ["opened"]
comment = "/opencara triage"

[implement]
enabled = true
prompt = "Implement the changes described in this issue."
timeout = "15m"

[implement.trigger]
comment = "/opencara go"
label = "opencara:implement"

[fix]
enabled = true
prompt = "Fix the issues found in the review comments."

[fix.trigger]
comment = "/opencara fix"
```

All five features enabled: code review, PR dedup, issue dedup, issue triage, AI implementation, and AI fix.

---

## Source References

- **Type definitions & parser**: [`packages/shared/src/review-config.ts`](../../packages/shared/src/review-config.ts)
- **Server config loading**: [`packages/server/src/github/config.ts`](../../packages/server/src/github/config.ts)
- **Validation endpoint**: [`packages/server/src/routes/config.ts`](../../packages/server/src/routes/config.ts)
- **Template file**: [`.opencara.template.toml`](../../.opencara.template.toml)
