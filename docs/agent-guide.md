# Agent Guide

This guide explains how to register and run AI coding agents on OpenCara.
All supported agents are invoked via `npx` — **no global install required**.

## Prerequisites

- Node.js 20 or later (ships `npx`)
- An OpenCara account with at least one project

That's it. You do **not** need to globally install `claude`, `codex`, `opencode`,
`pi`, or any other AI CLI tool. The dispatcher fetches the latest adapter
automatically on first use and caches it via npx's local cache.

## Supported agent kinds

| Kind       | Adapter fetched automatically                    | Required env var          |
|------------|--------------------------------------------------|---------------------------|
| `claude`   | `npx --yes --package=opencara@latest claude-acp` | `ANTHROPIC_API_KEY`       |
| `codex`    | `npx --yes @zed-industries/codex-acp@latest`     | `OPENAI_API_KEY`          |
| `opencode` | `npx --yes opencode-ai@latest acp`               | Provider key (see below)  |
| `pi`       | `npx --yes pi-acp@latest`                        | Provider key (see below)  |

### claude

Uses the `claude-acp` shim bundled in the `opencara` npm package. The shim
wraps your locally-installed `claude` CLI (Claude Code) and speaks the ACP
protocol, giving full fidelity: CLAUDE.md auto-discovery, settings.json,
MCP servers, OAuth auth, and session resume across flow iterations.

```
ANTHROPIC_API_KEY=sk-ant-...
```

Or run `claude auth login` once on the device and the shim will pick up
the stored credential automatically.

### codex

Uses the `@zed-industries/codex-acp` adapter — a Rust binary distributed
via npm optionalDependencies that links the codex-rs SDK directly.

```
OPENAI_API_KEY=sk-...
```

Note: ChatGPT-subscription auth from `codex login` is **not** supported in
remote-project contexts. Set the env var explicitly.

### opencode

Uses the official `opencode` CLI's native `acp` subcommand
(`opencode-ai@latest acp`).

Set whichever provider key matches your opencode config:

```
ANTHROPIC_API_KEY=sk-ant-...   # for claude models
OPENAI_API_KEY=sk-...          # for gpt models
```

### pi

Uses the `pi-acp@latest` community adapter for the pi coding agent.

```
KIMI_API_KEY=...          # for kimi models
MINIMAX_CN_API_KEY=...    # for MiniMax models
```

Pass `--provider X --model Y` in the agent's **Args** field to select a
provider and model:

```
--provider kimi-coding --model kimi-k2-thinking
```

## Quick start

1. Open the OpenCara dashboard → **Agents** → **New agent**.
2. Choose a **Kind** (e.g. `claude`).
3. Set the **Env** field to your API key.
4. Leave **Command** empty — npx auto-fetches the latest adapter.
5. Click **Save**, then pair a device with `npx opencara@latest`.

The agent is now ready to pick up flow runs and chat sessions.

## Pinning a version

If you need a specific adapter version (e.g. to avoid a regression), set the
**Command** field in the agent form:

```
# Pin claude-acp to a specific opencara release:
/path/to/bin/claude-acp

# Pin codex-acp:
npx --yes @zed-industries/codex-acp@0.13.0
```

Leave **Command** empty to always use `@latest`.

## Updating agents

Because adapters are fetched via `npx --yes package@latest`, they update
automatically as new versions are released — no manual `npm update -g`
needed. The npx cache is refreshed whenever a newer `@latest` tag is
published.

To force an immediate cache refresh on a device:

```bash
npx --yes --package=opencara@latest claude-acp --version
```

## Troubleshooting

### "npx: command not found"

Ensure Node.js 20+ is installed. `npx` ships with Node.js.

### Agent times out on first run

The first invocation may be slow while npx downloads the adapter. Subsequent
runs use the cached version and start in under a second.

### "adapter not found" error

Check that the agent's **Kind** matches one of the supported kinds in the
table above. The `custom` kind was removed in v0.30 — convert existing custom
agents to a named kind via the dashboard.
