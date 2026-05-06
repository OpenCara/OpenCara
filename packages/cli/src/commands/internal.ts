// `opencara internal` is orchestrator-facing infrastructure, not a stable
// operator surface. It's invoked as a subprocess by the orchestrator's
// flow engine to perform device-local work (today: worktree allocation
// and cleanup) without bumping the WS wire protocol. Operators don't run
// it directly; the flag set is whatever the engine generates.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

export async function internal(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "worktree") {
    const op = rest[0];
    const opArgs = rest.slice(1);
    if (op === "create") return worktreeCreate(opArgs);
    if (op === "remove") return worktreeRemove(opArgs);
    fail(`unknown worktree op: ${op ?? "(none)"}`);
  }
  fail(`unknown internal subcommand: ${sub ?? "(none)"}`);
}

function worktreeCreate(args: string[]): void {
  const repo = pickFlag(args, "--repo");
  const branch = pickFlag(args, "--branch");
  const fromRaw = pickFlag(args, "--from-branch") ?? "";
  const fromBranch = fromRaw.length > 0 ? fromRaw : null;
  if (!repo || !branch) {
    fail("worktree create requires --repo OWNER/NAME and --branch <name>");
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    fail(`invalid --repo '${repo}' (expected OWNER/NAME)`);
  }
  const token = process.env["GH_TOKEN"];
  if (!token) {
    fail("worktree create needs GH_TOKEN in env (the orchestrator injects this per run)");
  }

  const dir = mkdtempSync(join(tmpdir(), "opencara-wt-"));

  // Clone with token-in-URL so we can authenticate without a credential
  // helper at this point. We strip the token from `origin` immediately
  // after, so the token doesn't survive in .git/config — the per-worktree
  // credential helper below picks up GH_TOKEN at push time instead.
  const authedUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
  const cleanUrl = `https://github.com/${repo}.git`;

  const cloneArgs = ["clone", "--depth=1"];
  if (fromBranch) {
    cloneArgs.push("--branch", fromBranch);
  }
  cloneArgs.push(authedUrl, ".");

  try {
    git(dir, cloneArgs);
    git(dir, ["checkout", "-b", branch]);
    git(dir, ["remote", "set-url", "origin", cleanUrl]);
    // Single-quoted shell command embedded in git config — git invokes it
    // via /bin/sh when it needs creds. Reads $GH_TOKEN from the agent's
    // env at push time (whatever per-run token it has).
    git(dir, [
      "config",
      "credential.helper",
      "!f() { echo username=x-access-token; echo \"password=$GH_TOKEN\"; }; f",
    ]);
  } catch (err) {
    // Best-effort cleanup of the half-built dir before bubbling.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }

  process.stdout.write(`${JSON.stringify({ workdir: dir, branch })}\n`);
}

function worktreeRemove(args: string[]): void {
  const workdir = pickFlag(args, "--workdir");
  if (!workdir) {
    fail("worktree remove requires --workdir <path>");
  }
  // Idempotent: a missing dir is success. The cleanup pass runs at end
  // of every flow run, including failures that may have left no dir.
  if (!existsSync(workdir)) {
    return;
  }
  // Sanity check: only remove paths that resolve under the OS tmpdir.
  // Defends against a typo'd handle accidentally rm-rf'ing $HOME.
  const tmp = realpathSync(tmpdir());
  let resolved: string;
  try {
    resolved = realpathSync(workdir);
  } catch (err) {
    fail(`worktree remove: cannot resolve ${workdir}: ${(err as Error).message}`);
  }
  if (resolved !== tmp && !resolved.startsWith(tmp + sep)) {
    fail(`worktree remove: refuses to remove ${resolved} (not under ${tmp})`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

function git(cwd: string, args: string[]): void {
  // Inherit stderr so git's own error lines reach the agent_runs log,
  // making 401/404/branch-not-found easy to diagnose.
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "inherit"] });
}

function pickFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
