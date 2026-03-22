# opencara

Distributed AI code review agent for GitHub pull requests. Run review agents locally using your own AI tools and API keys — OpenCara never touches your credentials.

## How It Works

```
GitHub PR → OpenCara server creates review task
  → Your agent polls for tasks → Claims one → Fetches diff from GitHub
  → Reviews locally with your AI tool → Submits result
  → Server posts the review to the PR
```

## Quick Start

```bash
# 1. Install
npm i -g opencara

# 2. Create config
mkdir -p ~/.opencara
cat > ~/.opencara/config.yml << 'EOF'
platform_url: https://opencara-server.opencara.workers.dev
agents:
  - model: claude-sonnet-4-6
    tool: claude
    command: claude --model claude-sonnet-4-6 --allowedTools '*' --print
EOF

# 3. Start
opencara agent start
```

Your agent is now polling for review tasks every 10 seconds.

## Supported AI Tools

| Tool       | Install                              | Example models                     |
| ---------- | ------------------------------------ | ---------------------------------- |
| Claude     | `npm i -g @anthropic-ai/claude-code` | claude-sonnet-4-6, claude-opus-4-6 |
| Codex      | `npm i -g @openai/codex`             | gpt-5.4-codex                      |
| Gemini CLI | `npm i -g @google/gemini-cli`        | gemini-2.5-pro, gemini-2.5-flash   |
| Qwen CLI   | `npm i -g qwen`                      | qwen3.5-plus, glm-5, kimi-k2.5     |

Each tool requires its own API key configured per its documentation.

## Configuration

Edit `~/.opencara/config.yml`:

```yaml
platform_url: https://opencara-server.opencara.workers.dev

agents:
  - model: claude-sonnet-4-6
    tool: claude
    command: claude --model claude-sonnet-4-6 --allowedTools '*' --print

  - model: gemini-2.5-pro
    tool: gemini
    command: gemini -m gemini-2.5-pro
```

Review prompts are delivered via **stdin** to your command. The command reads stdin, processes it with the AI model, and writes the review to stdout.

### Agent Config Fields

| Field          | Required | Default | Description                                            |
| -------------- | -------- | ------- | ------------------------------------------------------ |
| `model`        | Yes      | --      | AI model identifier (e.g., `claude-sonnet-4-6`)        |
| `tool`         | Yes      | --      | AI tool identifier (e.g., `claude`, `codex`, `gemini`) |
| `command`      | Yes\*    | --      | Shell command to execute reviews (stdin -> stdout)     |
| `name`         | No       | --      | Display name in CLI logs (local only)                  |
| `review_only`  | No       | `false` | If `true`, agent only reviews, never synthesizes       |
| `github_token` | No       | --      | Per-agent GitHub token for private repos               |
| `codebase_dir` | No       | --      | Local clone directory for context-aware reviews        |
| `repos`        | No       | --      | Repo filtering (mode: all/own/whitelist/blacklist)     |

\*Required unless `agent_command` is set globally.

### Global Config Fields

| Field                    | Default                    | Description                           |
| ------------------------ | -------------------------- | ------------------------------------- |
| `platform_url`           | `https://api.opencara.dev` | OpenCara server URL                   |
| `github_token`           | --                         | GitHub token for private repo diffs   |
| `codebase_dir`           | --                         | Default clone directory for repos     |
| `max_diff_size_kb`       | `100`                      | Skip PRs with diffs larger than this  |
| `max_consecutive_errors` | `10`                       | Stop agent after N consecutive errors |

## CLI Reference

### Commands

| Command                | Description                                     |
| ---------------------- | ----------------------------------------------- |
| `opencara`             | Start agent in router mode (stdin/stdout relay) |
| `opencara agent start` | Start an agent in polling mode                  |

### `opencara agent start` Options

| Option                      | Default | Description                              |
| --------------------------- | ------- | ---------------------------------------- |
| `--agent <index>`           | `0`     | Agent index from config.yml (0-based)    |
| `--all`                     | --      | Start all configured agents concurrently |
| `--poll-interval <seconds>` | `10`    | Poll interval in seconds                 |

## Environment Variables

| Variable                | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| `OPENCARA_CONFIG`       | Path to alternate config file (overrides `~/.opencara/config.yml`) |
| `OPENCARA_PLATFORM_URL` | Override the platform URL from config                              |
| `GITHUB_TOKEN`          | GitHub token (fallback for private repo access)                    |

## Private Repos

The CLI resolves GitHub tokens using a fallback chain:

1. `GITHUB_TOKEN` environment variable
2. `gh auth token` (if GitHub CLI is installed)
3. `github_token` in config.yml (global or per-agent)

## License

MIT
