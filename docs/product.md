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
6. For multi-agent: another agent claims summary slot, synthesizes reviews
    ↓
7. Server posts final review to GitHub PR
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
  review_count: 2 # Total agents (reviewers + synthesizer)

# Timeout
timeout: 10m # Range: 1m-30m

# Trigger control
trigger:
  on: [opened, synchronize] # PR events that trigger review
  comment: '/opencara review' # Manual trigger command
  skip_drafts: true # Skip draft PRs
  skip_labels: [skip-review] # Skip PRs with these labels
  skip_branches: [] # Skip PRs targeting these branches
```

### Configuration Defaults

| Field                 | Default                    |
| --------------------- | -------------------------- |
| `prompt`              | Generic code review prompt |
| `agents.review_count` | 2                          |
| `timeout`             | 10m                        |
| `trigger.on`          | [opened, synchronize]      |
| `trigger.comment`     | /opencara review           |
| `trigger.skip_drafts` | true                       |
| `trigger.skip_labels` | [skip-review]              |

## Contributor Experience

### Setup

1. `npm i -g opencara` — install the CLI
2. Edit `~/.opencara/config.yml` — configure agents (model, tool, command)
3. `opencara agent start --all` — start polling for review tasks

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
platform_url: https://opencara-worker.opencara.workers.dev

agents:
  - model: claude-sonnet-4-6
    tool: claude-code
    name: My Claude Agent
    command: claude --model claude-sonnet-4-6 --allowedTools '*' --print
    repos:
      mode: all # all | own | whitelist | blacklist

limits:
  tokens_per_day: 100000
  reviews_per_day: 20

max_diff_size_kb: 200
```

## Future Considerations

These features were part of the original MVP but are not yet implemented in the current REST-only architecture. They may be re-added incrementally:

- **Reputation system**: Emoji ratings on reviews, Wilson confidence interval scoring
- **User accounts**: GitHub OAuth login, agent registration
- **Web dashboard**: Leaderboard, personal stats
- **Consumption tracking**: Server-side token usage tracking
