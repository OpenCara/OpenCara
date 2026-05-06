// `opencara internal` is orchestrator-facing infrastructure, not a stable
// operator surface. It's invoked as a subprocess by the orchestrator's
// flow engine to perform device-local work (today: worktree allocation,
// cleanup, and per-PR-branch agent-session-id storage) without bumping
// the WS wire protocol. Operators don't run it directly; the flag set
// is whatever the engine generates.

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

const SESSION_ROOT = join(homedir(), ".opencara", "sessions");

export async function internal(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "worktree") {
    const op = rest[0];
    const opArgs = rest.slice(1);
    if (op === "create") return worktreeCreate(opArgs);
    if (op === "remove") return worktreeRemove(opArgs);
    if (op === "write-session") return worktreeWriteSession(opArgs);
    fail(`unknown worktree op: ${op ?? "(none)"}`);
  }
  fail(`unknown internal subcommand: ${sub ?? "(none)"}`);
}

function worktreeCreate(args: string[]): void {
  const repo = pickFlag(args, "--repo");
  const branch = pickFlag(args, "--branch");
  const fromRaw = pickFlag(args, "--from-branch") ?? "";
  const fromBranch = fromRaw.length > 0 ? fromRaw : null;
  // Stable per-PR-branch dir for agent-session.json + scratchpad.
  // Engine passes a slug like "owner/repo/branch-foo"; CLI mkdir's it
  // under ~/.opencara/sessions/ and reads any pre-existing session
  // file to seed conversation resume.
  const sessionKey = pickFlag(args, "--session-key");
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

  // Sanity-check the token shape so a fat-fingered env doesn't smuggle
  // shell metachars into the credential helper string. GitHub
  // installation tokens are ASCII alphanumerics; reject anything else
  // before it lands in a `git -c` value.
  if (!/^[\w-]+$/.test(token)) {
    fail("GH_TOKEN contains unexpected characters; refusing to use");
  }

  const dir = mkdtempSync(join(tmpdir(), "opencara-wt-"));

  // The credential helper is a single-quoted shell snippet that git
  // execs via /bin/sh on auth challenge. It references $GH_TOKEN by
  // NAME — the token value never enters argv (process listings) or
  // .git/config. The helper is installed inline for the clone via
  // `git -c`, then persisted to the worktree's .git/config so a
  // downstream `git push` from inside the worktree picks up the token
  // from the agent's per-run env at that point.
  const HELPER_SNIPPET =
    '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';
  const cleanUrl = `https://github.com/${repo}.git`;

  const cloneArgs = ["-c", `credential.helper=${HELPER_SNIPPET}`, "clone", "--depth=1"];
  if (fromBranch) {
    cloneArgs.push("--branch", fromBranch);
  }
  cloneArgs.push(cleanUrl, ".");

  try {
    git(dir, cloneArgs);
    // If the branch we're "creating" matches the from-branch we just
    // cloned (review-fix flow: clones the existing PR branch), `-b`
    // would error with "branch already exists". Just check it out.
    if (fromBranch && branch === fromBranch) {
      git(dir, ["checkout", branch]);
    } else {
      git(dir, ["checkout", "-b", branch]);
    }
    git(dir, ["config", "credential.helper", HELPER_SNIPPET]);
  } catch (err) {
    // Best-effort cleanup of the half-built dir before bubbling.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }

  // Per-PR-branch persistent dir. Encode the slug safely so a branch
  // like "feat/x" doesn't escape the sessions root. The orchestrator
  // chooses the slug; we just sanity-check + mkdir.
  let sessionDir: string | null = null;
  let priorSession: { kind: string; id: string } | null = null;
  if (sessionKey) {
    const safeKey = sessionKey
      .split("/")
      .map((part) => part.replace(/[^A-Za-z0-9._-]/g, "_"))
      .filter((s) => s.length > 0)
      .join(sep);
    if (!safeKey) fail(`invalid --session-key '${sessionKey}'`);
    sessionDir = join(SESSION_ROOT, safeKey);
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, "agent-session.json");
    if (existsSync(sessionFile)) {
      try {
        const parsed = JSON.parse(readFileSync(sessionFile, "utf8")) as {
          kind?: unknown;
          id?: unknown;
        };
        if (typeof parsed.kind === "string" && typeof parsed.id === "string") {
          priorSession = { kind: parsed.kind, id: parsed.id };
        }
      } catch {
        // Malformed file — leave priorSession null so the agent does a
        // fresh run rather than resuming from corrupt state.
      }
    }
  }

  process.stdout.write(
    `${JSON.stringify({ workdir: dir, branch, sessionDir, priorSession })}\n`,
  );
}

function worktreeWriteSession(args: string[]): void {
  const dir = pickFlag(args, "--session-dir");
  const kind = pickFlag(args, "--kind");
  const id = pickFlag(args, "--id");
  if (!dir || !kind || !id) {
    fail("worktree write-session requires --session-dir <path> --kind <k> --id <id>");
  }
  // Sandbox: only write under ~/.opencara/sessions/. Defends against
  // an injected --session-dir that aims at $HOME or /etc. Ensure the
  // root exists first so realpathSync doesn't ENOENT on a fresh box.
  mkdirSync(SESSION_ROOT, { recursive: true });
  const root = realpathSync(SESSION_ROOT);
  let resolved: string;
  try {
    resolved = realpathSync(dir);
  } catch (err) {
    fail(`worktree write-session: cannot resolve ${dir}: ${(err as Error).message}`);
  }
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    fail(`worktree write-session: refuses to write to ${resolved} (not under ${root})`);
  }
  if (!/^[\w-]+$/.test(kind)) {
    fail(`worktree write-session: invalid --kind '${kind}'`);
  }
  if (id.length === 0 || id.length > 200) {
    fail("worktree write-session: --id must be 1..200 chars");
  }
  // Atomic write via tmp-then-rename so a crashed write doesn't leave
  // a half-flushed file that would deserialize as malformed.
  const dst = join(resolved, "agent-session.json");
  const tmp = `${dst}.tmp`;
  writeFileSync(tmp, JSON.stringify({ kind, id }) + "\n", { encoding: "utf8" });
  renameSync(tmp, dst);
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
    // Race: the dir vanished between existsSync and realpathSync (e.g.
    // a concurrent cleanup or external rm). Treat as success — the
    // contract is "after this call returns 0, workdir does not exist."
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
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
