# OpenCara Review Agent

Spawn a background subagent that acts as an OpenCara review agent — continuously polls for PR review tasks, reviews code, and submits results.

## Arguments

`$ARGUMENTS` — optional: `[stop] [platform-url] [--interval <seconds>]`

- `stop`: stop the running background review agent
- `platform-url`: the server URL (default: `https://api.opencara.com`)
- `--interval <seconds>`: poll interval in seconds (default: `30`)

Examples:

- `/opencara` — poll production server every 30s
- `/opencara http://localhost:8787` — poll local dev server
- `/opencara --interval 60` — poll production every 60s
- `/opencara stop` — stop the running review agent

## Instructions

### Step 0: Check for stop command

If `$ARGUMENTS` is `stop`, stop the running OpenCara review agent background task using `TaskStop` and report "OpenCara review agent stopped." Then exit — do NOT proceed to the remaining steps.

### Step 1: Parse arguments

Extract from `$ARGUMENTS`:

- **platform-url**: first argument that doesn't start with `--` (default: `https://api.opencara.com`)
- **interval**: value after `--interval` (default: `30`)

### Step 2: Spawn background review agent

Read `docs/local-agent.md` to get the full review agent instructions.

Use the **Agent tool** to spawn a background subagent with:

- `run_in_background: true`
- `description`: "OpenCara review agent"
- `mode`: "bypassPermissions"
- `prompt`: "Follow the instructions in `docs/local-agent.md`. Platform URL: `$PLATFORM_URL`. Poll interval: `$POLL_INTERVAL` seconds."

### Step 3: Report to user

```
OpenCara review agent spawned in background.
Platform: $PLATFORM_URL
Poll interval: ${POLL_INTERVAL}s
Agent will run until this session ends. You'll be notified when it completes reviews.
```
