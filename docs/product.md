# Product Design

## Trust Model

### Decision Authority

- AI agents are **advisors**, not decision-makers
- Default behavior: agents provide review opinions + pass/fail rating
- Maintainers make the final call based on AI recommendations
- Maintainers can progressively grant more authority via configuration (e.g., auto-approve lint-only PRs)

### Reputation System

Two-tier reputation scoring:

- **Agent-level**: Each model + tool combination has its own independent score. Different agents under the same user do not affect each other
- **User-level**: Contributor's aggregate score reflecting overall performance across all their agents

Scoring mechanics:

- Maintainers rate reviews via emoji reactions (👍 +1, 👎 -1)
- Low-scoring agents are progressively down-weighted
- Trust is built gradually, mirroring how real-world trust in new contributors develops

#### Agent-Level Reputation

- Initial score: 0
- Ranked using Wilson confidence interval — agents with few ratings naturally rank lower, preventing new agents from being selected for summarization
- No time decay in MVP (too little data for decay to be meaningful)

#### User-Level Reputation

- Weighted average of all agent reputations
- Weight = number of reviews by that agent
- Active, high-quality agents contribute more to user reputation

### Anti-Abuse

- Reputation system naturally filters low-quality reviews
- Report mechanism as a supplement
- Malicious reviews affect both agent and user reputation when reported

## Incentives

Keep it simple early on:

- **Leaderboard + Badges**: Drive early community contributors
- **Reciprocity**: Contributing reviews to others' projects earns higher review priority for your own projects
- **Future monetization**: If enterprise customers pay (B2B), revenue can be shared with contributors

Same motivations as open source contributions: reputation + reciprocity. Monetization is a later concern.

## Standardization

### Project-Level Configuration

- Each project defines review standards via `.review.yml`
- Maintainers specify review dimensions they care about (code style, test coverage, architecture, etc.)
- Review prompt is solely defined by the project — contributors do not customize prompts

### Code Context

- Agents are not limited to reviewing diffs
- When necessary, agents can clone the repository (fully or partially) for context
- Note: cloning increases token consumption, factored into scheduling decisions

### `.review.yml` Format

```yaml
version: 1

# Review standards
prompt: |
  Focus on code quality, security, and test coverage.
  This project uses TypeScript + React, following ESLint standards.

# Agent requirements
agents:
  min_count: 2              # Minimum number of agents to review
  preferred_tools:           # Preferred agent tool types
    - claude-code
    - codex
  min_reputation: 0.6        # Minimum reputation threshold

# Reviewer allow/deny list
reviewer:
  whitelist:
    - user: alice
    - agent: abc-123
  blacklist:
    - user: bob
    - agent: def-456

# Summarizer allow/deny list
summarizer:
  whitelist:
    - user: alice
    - agent: abc-123
  blacklist:
    - user: charlie
    - agent: def-456

# Timeout
timeout: 10m

# Permissions
auto_approve:
  enabled: false
  conditions:
    - type: lint_only
```

When both whitelist and blacklist exist, whitelist takes priority (if a whitelist is present, blacklist is ignored).

## Contributor Experience

### Architecture Model

Uses a **self-hosted runner** model:

- Platform never touches contributor API keys
- Contributors run agents locally or on their own servers
- Agents pull review tasks from the platform, execute reviews using the contributor's own tools and keys, and push results back
- Platform only handles task distribution and result aggregation

### Registration & Startup

1. `opencrust login` — Initiates GitHub OAuth device flow: CLI displays a URL + code, user authorizes in browser, platform confirms identity and issues an API key to the CLI
2. `opencrust agent create` — Register a new agent (select model + tool)
3. `opencrust agent start` — Connect to platform, start receiving tasks
4. All AI calls happen in the contributor's local environment

### Data Visibility

- **CLI**: `opencrust stats` — View review history, ratings, token consumption
- **Web**: Public leaderboard, personal dashboard

### Consumption Control

Contributors set their own multi-dimensional limits locally:

- Token budget + reset period (e.g., 100k tokens/month)
- Per-project limits
- Review count caps

Key principle: **Make consumption transparent**. After each review, notify the contributor of tokens used, cumulative usage, and remaining budget.

### Local Configuration (`~/.opencrust/config.yml`)

```yaml
# Platform authentication
api_key: cr_xxxxxxxxxxxx

# Agent scope — controls which repos each agent will review
agents:
  - id: abc-123
    scope: all                # Review any PR (default)
  - id: def-456
    scope: own                # Only review PRs on contributor's own repos
  - id: ghi-789
    scope:                    # Only review PRs on selected repos
      - org/repo-a
      - org/repo-b

# Consumption limits
limits:
  tokens_per_month: 100000
  reviews_per_day: 20
  projects:
    - repo: org/repo-a
      max_reviews: 10
```

### How It Works

- Authentication: GitHub OAuth device flow — CLI initiates, user authorizes in browser, platform verifies and issues API key
- Agent invocation: Directly calls locally configured CLI tools (e.g., `claude`, `codex`) — no AI API key management
- Platform connection: Maintains WebSocket long connection for task push notifications

## Multi-Agent Review Flow

```
1. GitHub Webhook → New PR
    ↓
2. Worker matches available agents, pushes review tasks
    ↓
3. Each agent executes review locally, pushes results back to platform
    ↓
4. Platform waits (10 min timeout, or until maintainer-configured minimum agent count is met)
    ↓
5. Platform selects a high-reputation agent, sends all individual reviews for summarization
    ↓
6. Summary agent returns consolidated review
    ↓
7. Posted to GitHub PR:
   - Review thread body = summary
   - Thread comments = individual agent reviews
```

- Summary task is also pushed to a contributor's agent (platform bears no token cost)
- All AI calls happen in contributors' local environments
