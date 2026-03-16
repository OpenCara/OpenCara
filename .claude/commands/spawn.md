# Spawn Agent

Spawn a teammate agent from the project's agent definitions in `.claude/agents/` and add it to the current team.

## Arguments

`$ARGUMENTS` — format: `<agent-type> [issue-number] [extra context]`

Examples:

- `/spawn architect 61` — spawn architect for issue #61
- `/spawn pm` — spawn the PM agent
- `/spawn worker-dev 63 "Add webhook endpoint"` — spawn worker-dev for issue #63
- `/spawn qa` — spawn QA agent

## Instructions

### Step 1: Parse arguments

Extract from `$ARGUMENTS`:

- **agent-type** (required): one of the agent files in `.claude/agents/` (architect, pm, worker-dev, cli-dev, web-dev, qa, clarifier)
- **issue-number** (optional): GitHub issue to work on
- **extra-context** (optional): additional instructions

If agent-type is missing or not found in `.claude/agents/`, list available agents and ask the user to pick one.

### Step 2: Ensure a team exists

Check if a team is active. If not, create one with `TeamCreate` (team name: `opencrust-dev`).

### Step 3: Read the agent definition

Read `.claude/agents/<agent-type>.md` to get the full agent definition.

### Step 4: Determine spawn configuration

| Agent      | Isolation           | Mode |
| ---------- | ------------------- | ---- |
| pm         | none (root project) | auto |
| architect  | worktree            | auto |
| worker-dev | worktree            | auto |
| cli-dev    | worktree            | auto |
| web-dev    | worktree            | auto |
| qa         | worktree            | auto |
| clarifier  | none                | auto |

**Model**: Do NOT set the `model` parameter on the Agent tool. Agents inherit the model and context window from the team lead. This ensures all agents run with the same model configuration (including 1M context if the team lead has it).

### Step 5: Pre-create worktree (if needed)

For agents that need a worktree (all except pm and clarifier):

**CRITICAL**: Always create worktrees from the root project directory `/home/quabug/opencrust` on `main` branch. NEVER create worktrees from inside another worktree — this causes nested paths and broken worktrees.

```bash
cd /home/quabug/opencrust  # MUST be root project, NOT a worktree
git pull origin main
git worktree add .claude/worktrees/<agent-type>-<issue-number>-<short-desc> origin/main -b issue-<issue-number>-<short-desc>
```

If no issue number, use a descriptive name:

```bash
git worktree add .claude/worktrees/<agent-type>-<task-desc> origin/main -b <agent-type>-<task-desc>
```

### Step 6: Spawn the agent as a teammate

Use the Agent tool with:

- **name**: `<agent-type>-<issue-number>` (e.g., `architect-61`) or `<agent-type>` for PM/QA
- Do NOT set `model` — agents inherit from the team lead
- **mode**: `auto`
- **team_name**: `opencrust-dev` (adds agent to the team)
- **prompt**: Include the full agent definition from the .md file, plus:
  - The issue number and instructions to read it with `gh issue view <number>`
  - The worktree path (if applicable)
  - Dependencies that are already merged (check pm-notebook.md or ask)
  - Reminder to follow `.claude/rules/development-workflow.md`
  - CRITICAL warning about working only in their worktree
  - Instruction to read and follow project configuration at startup: `CLAUDE.md` (project conventions, code style), all rules in `.claude/rules/` (workflow requirements), and `.claude/settings.local.json` (project settings). These apply to all agents.

Do NOT set `run_in_background`. The Agent tool with `team_name` automatically adds the agent as a teammate.

### Step 7: Confirm

Report to the user:

- Agent name and type
- Issue number (if any)
- Worktree path (if any)
- Team membership

## Rules

- **Always read the agent definition file** — never hardcode agent prompts
- **PM runs on root project only** — never in a worktree
- **Only one PM at a time** — check if a PM is already running before spawning
- **Pre-create worktrees from root project** — never from inside another worktree
- **Fetch latest main** before creating worktrees
- **Always add to team** — agents must be spawned as teammates, not background tasks
