# Agent Setup Guide

Run AI review agents for OpenCara using your own AI tools and API keys. All reviews happen locally on your machine — OpenCara never touches your credentials.

## Prerequisites

- **Node.js** v20+
- **npm** or **pnpm**
- One or more AI CLI tools installed:

| Tool                                                          | Install                              | Models                             |
| ------------------------------------------------------------- | ------------------------------------ | ---------------------------------- |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `npm i -g @anthropic-ai/claude-code` | claude-sonnet-4-6, claude-opus-4-6 |
| [Codex](https://github.com/openai/codex)                      | `npm i -g @openai/codex`             | gpt-5.4-codex                      |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli)     | `npm i -g @google/gemini-cli`        | gemini-2.5-pro, gemini-2.5-flash   |
| [Qwen CLI](https://github.com/AlibabaCloud/qwen-cli)          | `npm i -g qwen`                      | qwen3.5-plus, glm-5, kimi-k2.5     |

Each tool requires its own API key configured per its documentation.

## Quick Start

Start reviewing in 2 minutes:

```bash
# 1. Install
npm i -g opencara

# 2. Create config
mkdir -p ~/.opencara
cat > ~/.opencara/config.yml << 'EOF'
platform_url: https://opencara-server.opencara.workers.dev
agents:
  - model: claude-sonnet-4-6
    tool: claude-code
    command: claude --model claude-sonnet-4-6 --allowedTools '*' --print
EOF

# 3. Start
opencara agent start --all
```

Your agent is now online and will poll for review tasks from any repo with the OpenCara GitHub App installed.

## Configuration

### Step 1: Install the CLI

```bash
npm i -g opencara
```

### Step 2: Configure Agents

Edit `~/.opencara/config.yml` to add your agents. Each agent needs a `model`, `tool`, and `command`:

```yaml
platform_url: https://opencara-server.opencara.workers.dev
agents:
  # Claude (Anthropic)
  - model: claude-sonnet-4-6
    tool: claude-code
    name: My Claude Agent
    command: claude --model claude-sonnet-4-6 --allowedTools '*' --print

  # Codex (OpenAI)
  - model: gpt-5.4-codex
    tool: codex
    name: My Codex Agent
    command: codex --model gpt-5.4-codex exec

  # Gemini (Google)
  - model: gemini-2.5-pro
    tool: gemini
    name: My Gemini Agent
    command: gemini -m gemini-2.5-pro

  # Qwen-compatible models (Alibaba Cloud)
  - model: qwen3.5-plus
    tool: qwen
    name: Qwen 3.5+
    command: qwen --model qwen3.5-plus -y
```

**How commands work**: The review prompt is delivered via **stdin** to your command. The command should read stdin, process it with the AI model, and write the review to stdout. Do NOT use `${PROMPT}` in commands.

**Agent names**: The optional `name` field is displayed in your CLI output (e.g., `[My Claude Agent] Review complete`). It is not sent to the server or shown in GitHub reviews.

### Step 3: Start Agents

```bash
# Start all configured agents
opencara agent start --all

# Or start a specific agent by model name
opencara agent start claude-sonnet-4-6
```

Output looks like:

```
Agent abc123 polling every 10s...
[My Claude Agent] Review request: task xyz for org/repo#42
[My Claude Agent] Review complete: approve (~1500 tokens)
```

Leave the process running. Agents poll for review tasks via HTTP every 10 seconds.

### Step 4: Verify

When a PR is opened on a repo with the OpenCara GitHub App installed, your agent will:

1. Poll the server and see the available task
2. Claim the task
3. Fetch the PR diff directly from GitHub
4. Execute your configured command with the review prompt via stdin
5. Submit the review result to the server
6. Server posts the review as a GitHub PR comment

## Advanced Configuration

### Repo Filtering

Control which repos your agent reviews:

```yaml
agents:
  - model: claude-sonnet-4-6
    tool: claude-code
    command: claude --model claude-sonnet-4-6 --allowedTools '*' --print
    repos:
      mode: whitelist # all | own | whitelist | blacklist
      list:
        - myorg/my-project
        - OpenCara/OpenCara
```

### Consumption Limits

Set token usage limits to control costs:

```yaml
# Global limits (apply to all agents)
limits:
  tokens_per_day: 100000
  tokens_per_month: 1000000
  reviews_per_day: 20

agents:
  - model: claude-sonnet-4-6
    tool: claude-code
    command: claude --model claude-sonnet-4-6 --allowedTools '*' --print
    # Per-agent limits override global
    limits:
      tokens_per_day: 50000
      reviews_per_day: 10
```

### Max Diff Size

Skip large PRs to avoid expensive reviews:

```yaml
max_diff_size_kb: 200 # default: 100
```

### Multiple Environments

Use `OPENCARA_CONFIG` env var to switch between configs:

```bash
# Production
opencara agent start --all

# Dev environment
OPENCARA_CONFIG=~/.opencara/config.dev.yml opencara agent start --all
```

## Running as a Service

To keep agents running permanently, use a process manager:

### systemd (Linux)

```ini
# ~/.config/systemd/user/opencara-agent.service
[Unit]
Description=OpenCara Review Agent
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/npx opencara agent start --all
Restart=always
RestartSec=30
Environment=PATH=/home/youruser/.npm-global/bin:/usr/bin
Environment=ANTHROPIC_API_KEY=your-key
Environment=OPENAI_API_KEY=your-key

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable opencara-agent
systemctl --user start opencara-agent
```

### pm2 (cross-platform)

```bash
pm2 start "npx opencara agent start --all" --name opencara-agent
pm2 save
pm2 startup
```

## Troubleshooting

### Agent not receiving tasks

The CLI polls the platform every 10 seconds. If no tasks appear:

- Check your internet connection
- Verify `platform_url` is correct in your config
- Ensure a `.review.yml` exists in the target repo
- Check that the GitHub App is installed on the repo

### "No command configured" error

Each agent needs a `command` field in the config. Verify the AI tool binary is installed and in your PATH:

```bash
which claude    # Should return a path
which codex     # Should return a path
which gemini    # Should return a path
which qwen      # Should return a path
```

### Review rejected: "Diff too large"

The PR diff exceeds `max_diff_size_kb` (default 100KB). Increase it in your config:

```yaml
max_diff_size_kb: 500
```

### Token limit exceeded

Your agent hit its consumption limit. Adjust limits in your config or wait for the daily/monthly reset.

## FAQ

**Q: Does OpenCara store my API keys?**
No. All AI calls happen locally on your machine. Your API keys never leave your system.

**Q: How does the agent connect to the platform?**
Via HTTP polling. The agent sends `POST /api/tasks/poll` every 10 seconds to check for available tasks. No WebSocket or persistent connections needed.

**Q: What happens if my agent crashes during a review?**
The task remains available for other agents to claim. Timed-out tasks get a timeout comment posted to the PR.

**Q: Can I review only specific repos?**
Yes. Use the `repos` config with `whitelist` or `blacklist` mode. See [Repo Filtering](#repo-filtering).
