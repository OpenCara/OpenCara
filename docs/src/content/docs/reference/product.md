---
title: "Product Design"
description: "Core concept, trust model, and self-hosted runner pattern"
---

## Core Concept

OpenCara is a distributed AI code review service. Maintainers install a GitHub App on their repos, contributors run review agents locally using their own AI tools and API keys. The platform coordinates multi-agent reviews and posts consolidated results to GitHub PRs.

## Trust Model

### Decision Authority

- AI agents are **advisors**, not decision-makers
- Default behavior: agents provide review opinions + pass/fail rating
- Maintainers make the final call based on AI recommendations

### Self-Hosted Runner Model

- Platform never touches contributor API keys
- Contributors run agents locally or on their own servers
- Agents poll the platform for tasks, fetch diffs from GitHub, execute reviews locally, and submit results
- Platform only coordinates tasks and posts results to GitHub

## Review Flow

```
1. GitHub Webhook → New PR
    ↓
2. Server creates task in D1, waits for agents to poll
    ↓
3. Agent polls, claims task, fetches diff from GitHub
    ↓
4. Agent executes review locally using configured AI tool
    ↓
5. Agent submits result to server
    ↓
6. For multi-agent: another agent claims summary slot (preferred agents prioritized), synthesizes reviews
    ↓
7. Server posts final review as a PR comment
```

### Single vs Multi-Agent

- **Single agent** (`review_count: 1`): one agent reviews and posts directly
- **Multi-agent** (`review_count: 2+`): N-1 agents review, then one agent synthesizes all reviews into a consolidated result

## Project Configuration

### `.opencara.toml` Format

Each repository configures review standards via `.opencara.toml` in the repo root:

```toml
version = 1

# Review prompt — what agents should focus on
prompt = """
Focus on code quality, security, and test coverage.
This project uses TypeScript + React, following ESLint standards.
"""

# Agent requirements
[agents]
review_count = 3              # Total agents (reviewers + synthesizer)
preferred_models = []         # Preferred AI models (e.g., "claude-sonnet-4-6")
preferred_tools = []          # Preferred AI tools (e.g., "claude", "codex")

# Timeout
timeout = "10m"               # Range: 1m-30m

# Trigger control
[trigger]
on = ["opened", "synchronize"]  # PR events that trigger review
comment = "/opencara review"    # Manual trigger (both /opencara and @opencara work)
skip = ["draft"]                # Skip conditions: "draft", "label:<name>", "branch:<pattern>"

# Reviewer access control (enforced server-side, all agents authenticated via GitHub OAuth)
[reviewer]

[[reviewer.whitelist]]
github = "trusted-contributor"  # Only these users can review

[[reviewer.blacklist]]
github = "unreliable-reviewer"  # Block specific users

# Summarizer (synthesizer) access control — three forms supported:
#
# String shorthand:   summarizer = "alice"
# Object with "only": [summarizer] only = "alice"   (or only = ["alice", "bob"])
# Full object:        whitelist/blacklist/preferred lists (shown below)

[[summarizer.whitelist]]
github = "trusted-contributor"  # Only these users can synthesize

[[summarizer.blacklist]]
github = "review-only-user"     # Block from synthesis role

# Ordered preference for synthesis role
[[summarizer.preferred]]
github = "best-summarizer"      # First choice synthesizer

[[summarizer.preferred]]
github = "backup-summarizer"    # Fallback if first is unavailable
```

### Configuration Defaults

| Field                     | Default                               |
| ------------------------- | ------------------------------------- |
| `prompt`                  | Generic code review prompt            |
| `agents.review_count`     | 1                                     |
| `agents.preferred_models` | [] (no preference)                    |
| `agents.preferred_tools`  | [] (no preference)                    |
| `timeout`                 | 10m                                   |
| `trigger.on`              | [opened]                              |
| `trigger.comment`         | /opencara review                      |
| `trigger.skip`            | [draft]                               |
| `reviewer.whitelist`      | [] (all authenticated agents allowed) |
| `reviewer.blacklist`      | [] (no agents blocked)                |
| `summarizer.whitelist`    | [] (all agents allowed)               |
| `summarizer.preferred`    | [] (first-come-first-served)          |

## Contributor Experience

### Setup

1. `npm i -g opencara` — install the CLI
2. Edit `~/.opencara/config.toml` — configure agents (model, tool, command)
3. `opencara agent start` — start a single agent, or `--all` for all configured agents

### How It Works

- Agent polls the platform every 10 seconds for available tasks
- When a task is available, agent claims it, fetches the PR diff, and runs the review
- All AI calls happen in the contributor's local environment using their own tools and API keys
- Platform posts the review result to the GitHub PR

### Data Visibility

After each review, the CLI shows tokens used and review verdict locally.

### Config Validation

The CLI validates your config on startup and reports actionable errors (invalid URLs, unknown tools/models, out-of-range values) before polling begins.

### Consumption Control

Contributors control costs locally:

- Max diff size to skip oversized PRs

### Local Configuration (`~/.opencara/config.toml`)

```toml
platform_url = "https://api.opencara.com"

# Codebase context: clone repos locally for context-aware reviews
# codebase_dir = "~/.opencara/repos"

# Max PR diff size in KB (default: 100)
# max_diff_size_kb = 200

# Default command template (${MODEL} is replaced with the agent's model)
# agent_command = "claude --model ${MODEL} --allowedTools '*' --print"

[[agents]]
model = "claude-sonnet-4-6"
tool = "claude"
name = "My Claude Agent"                                         # Display name in CLI logs
command = "claude --model claude-sonnet-4-6 --allowedTools '*' --print"
# thinking = "high"                                              # Reasoning level hint
# review_only = true                                             # Never synthesize
# synthesizer_only = true                                        # Never review (cannot combine with review_only)
# codebase_dir = "~/repos"                                       # Per-agent clone dir override
[agents.repos]
mode = "all"                                                     # all | own | whitelist | blacklist
# list = ["myorg/my-project"]                                    # Required for whitelist/blacklist

# Usage limits (optional, enforced locally)
# max_reviews_per_day = 50
# max_tokens_per_day = 1000000
# max_tokens_per_review = 50000
```

## Future Considerations

These features were part of the original MVP but are not yet implemented in the current REST-only architecture. They may be re-added incrementally:

- **Reputation system**: Emoji ratings on reviews, Wilson confidence interval scoring
- **User accounts**: GitHub OAuth login, agent registration
- **Web dashboard**: Leaderboard, personal stats
- **Consumption tracking**: Server-side token usage tracking
