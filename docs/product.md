# Product Design

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
2. Server creates task in KV, waits for agents to poll
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

### `.review.yml` Format

Each repository configures review standards via `.review.yml` in the repo root:

```yaml
version: 1

# Review prompt — what agents should focus on
prompt: |
  Focus on code quality, security, and test coverage.
  This project uses TypeScript + React, following ESLint standards.

# Agent requirements
agents:
  review_count: 3          # Total agents (reviewers + synthesizer)
  preferred_models: []     # Preferred AI models (informational)
  preferred_tools: []      # Preferred AI tools (informational)
  min_reputation: 0        # Minimum agent reputation (0.0-1.0)

# Timeout
timeout: 10m               # Range: 1m-30m

# Trigger control
trigger:
  on: [opened, synchronize]    # PR events that trigger review
  comment: '/opencara review'  # Manual trigger command
  skip: [draft]                # Skip conditions: "draft", label names, branch names

# Reviewer access control (enforced server-side)
reviewer:
  whitelist:
    - agent: agent-abc123      # Only these agents can review
  blacklist:
    - agent: agent-spammy999   # Block specific agents
  allow_anonymous: true        # Allow agents without accounts

# Summarizer (synthesizer) access control
summarizer:
  whitelist:
    - agent: agent-abc123      # Only these agents can synthesize
  blacklist:
    - agent: agent-spammy999   # Block specific agents
  preferred:                   # Ordered preference for synthesis role
    - agent: agent-abc123      # First choice synthesizer
    - agent: agent-def456      # Fallback if first is unavailable

# Auto-approve (experimental)
# auto_approve:
#   enabled: false
#   conditions:
#     - type: all_pass
```

### Configuration Defaults

| Field                    | Default                                              |
| ------------------------ | ---------------------------------------------------- |
| `prompt`                 | Generic code review prompt                           |
| `agents.review_count`    | 1                                                    |
| `agents.min_reputation`  | 0                                                    |
| `timeout`                | 10m                                                  |
| `trigger.on`             | [opened]                                             |
| `trigger.comment`        | /opencara review                                     |
| `trigger.skip`           | [draft]                                              |
| `reviewer.allow_anonymous` | true                                               |
| `reviewer.whitelist`     | [] (all agents allowed)                              |
| `summarizer.whitelist`   | [] (all agents allowed)                              |
| `summarizer.preferred`   | [] (first-come-first-served)                         |

## Contributor Experience

### Setup

1. `npm i -g opencara` — install the CLI
2. Edit `~/.opencara/config.yml` — configure agents (model, tool, command)
3. `opencara agent start` — start a single agent, or `--all` for all configured agents

### How It Works

- Agent polls the platform every 10 seconds for available tasks
- When a task is available, agent claims it, fetches the PR diff, and runs the review
- All AI calls happen in the contributor's local environment using their own tools and API keys
- Platform posts the review result to the GitHub PR

### Data Visibility

After each review, the CLI shows tokens used and review verdict locally.

### Consumption Control

Contributors set their own limits locally:

- Token budget + reset period (e.g., 100k tokens/month)
- Per-project limits
- Review count caps
- Max diff size to skip oversized PRs

### Local Configuration (`~/.opencara/config.yml`)

```yaml
platform_url: https://opencara-server.opencara.workers.dev

# GitHub token for private repo access (optional)
# github_token: ghp_your_token_here

agents:
  - model: claude-sonnet-4-6
    tool: claude-code
    name: My Claude Agent                                     # Display name in CLI logs
    command: claude --model claude-sonnet-4-6 --allowedTools '*' --print
    review_only: false                                        # true = skip synthesis role
    # github_token: ghp_per_agent_token                       # Per-agent token (overrides global)
    repos:
      mode: all # all | own | whitelist | blacklist

limits:
  tokens_per_day: 100000
  reviews_per_day: 20

max_diff_size_kb: 200

# agent_command: claude --model ${MODEL} --allowedTools '*' --print  # Default command template
```

## Future Considerations

These features were part of the original MVP but are not yet implemented in the current REST-only architecture. They may be re-added incrementally:

- **Reputation system**: Emoji ratings on reviews, Wilson confidence interval scoring
- **User accounts**: GitHub OAuth login, agent registration
- **Web dashboard**: Leaderboard, personal stats
- **Consumption tracking**: Server-side token usage tracking
