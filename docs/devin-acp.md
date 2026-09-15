# Devin CLI

OpenCara's `devin` agent kind uses the official Devin CLI's native Agent Client
Protocol server. OpenCara starts it as `devin acp` on the paired device and
passes the run worktree through the ACP session.

## Install and authenticate

Install the CLI on every paired device that may run Devin jobs:

```bash
curl -fsSL https://cli.devin.ai/install.sh | bash
devin auth login
```

For a headless or SSH-only device, use the manual token flow:

```bash
devin auth login --force-manual-token-flow
```

The official installer puts `devin` in `~/.local/bin`. Verify that both your
shell and the OpenCara device daemon can resolve it:

```bash
devin --version
devin auth status
```

Devin can alternatively authenticate from `WINDSURF_API_KEY` in the OpenCara
agent's env configuration. Avoid putting the token in project files.

## Configure OpenCara

Create an agent in `/agents` and select **Devin CLI**. The adapter command is
fixed to `devin`; its default adapter arguments are `acp`.

The normal extra-args field is appended to that invocation. For example,
`--model swe-2-max` selects a model, applied over ACP
`session/set_config_option`. Model ids are tier-qualified (`swe-2-high`,
`swe-2-medium`, `swe-2-max`, `adaptive`, ...); a bare family name such as
`swe-2` is rejected with "Model not found" and the run falls back to Devin's
configured default. Leave the model empty to use Devin's configured default.

Devin advertises session resume, image prompts, model configuration, and slash
commands over ACP. OpenCara persists the ACP session ID and resumes it when a
later run is pinned to the same device.

### OpenCara MCP limitation

Devin CLI 3000.10.21 starts and connects the stdio MCP server supplied in
ACP's `session/new`, but does not register its tools in the session. Devin's
`mcp_list_servers` remains empty and `mcp_list_tools` reports that `opencara`
is not configured. As a result, the three OpenCara MCP tools are unavailable
to Devin runs in this version. Repository-local file editing, commands, git,
ACP output streaming, and session resume still work normally.

## Verify

Use the agent's **Test** action in `/agents` after the paired device is online.
An authentication error means `devin auth login` was run as a different OS user
than the OpenCara daemon. Authenticate as the daemon user, or configure
`WINDSURF_API_KEY` on the agent.

The upstream command reference is at
<https://docs.devin.ai/cli/reference/commands#devin-acp>.
