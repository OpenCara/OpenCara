// `opencara internal` is orchestrator-facing infrastructure, not a stable
// operator surface. It's invoked as a subprocess by the orchestrator's
// flow engine to perform device-local work (today: worktree allocation,
// cleanup, and per-PR-branch agent-session-id storage) without bumping
// the WS wire protocol. Operators don't run it directly; the flag set
// is whatever the engine generates.

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

const OPENCARA_ROOT = join(homedir(), ".opencara");
// Per-PR-branch trees are siblings under ~/.opencara/. Both keyed by
// the same `--key <slug>`. The orchestrator's pull_request.closed
// handler dispatches `worktree remove` to wipe both for that key.
const WORK_ROOT = join(OPENCARA_ROOT, "work");
const SESSION_ROOT = join(OPENCARA_ROOT, "sessions");

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

// Sanitize a key like "owner/repo/branch-foo" into a slash-separated
// path safe to live under ~/.opencara/. Each segment is restricted to
// [\w.-]; non-matching chars become underscores. Empty segments are
// dropped. Returned as a path relative to the root (no leading sep).
function safeKey(rawKey: string): string {
  return rawKey
    .split("/")
    .map((part) => part.replace(/[^A-Za-z0-9._-]/g, "_"))
    .filter((s) => s.length > 0)
    .join(sep);
}

function worktreeCreate(args: string[]): void {
  const repo = pickFlag(args, "--repo");
  const branch = pickFlag(args, "--branch");
  const fromRaw = pickFlag(args, "--from-branch") ?? "";
  const fromBranch = fromRaw.length > 0 ? fromRaw : null;
  // Stable per-PR-branch slug. Engine passes `owner/repo/branch-<safe>`;
  // CLI mkdir's both `~/.opencara/work/<key>/checkout/` and
  // `~/.opencara/sessions/<key>/`, and reads any pre-existing session
  // file to seed conversation resume.
  const rawKey = pickFlag(args, "--key") ?? pickFlag(args, "--session-key");
  if (!repo || !branch) {
    fail("worktree create requires --repo OWNER/NAME and --branch <name>");
  }
  if (!rawKey) {
    fail("worktree create requires --key <slug>");
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

  const key = safeKey(rawKey);
  if (!key) fail(`invalid --key '${rawKey}'`);
  const sessionDir = join(SESSION_ROOT, key);
  const checkoutDir = join(WORK_ROOT, key, "checkout");

  // The credential helper is a single-quoted shell snippet that git
  // execs via /bin/sh on auth challenge. It references $GH_TOKEN by
  // NAME — the token value never enters argv (process listings) or
  // .git/config. Installed inline at clone time AND persisted in the
  // worktree's .git/config so a downstream `git push`/`git fetch`
  // also picks up the agent's per-run token.
  const HELPER_SNIPPET =
    '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';
  const cleanUrl = `https://github.com/${repo}.git`;

  mkdirSync(sessionDir, { recursive: true });

  // Idempotent allocation. The implement flow on first run does the
  // clone; every subsequent flow run on the same (repo, branch) finds
  // the .git/ already there, skips the clone, fetches latest, and
  // checks out the branch. Removed only when the orchestrator's
  // pull_request.closed handler dispatches `worktree remove`.
  if (existsSync(join(checkoutDir, ".git"))) {
    git(checkoutDir, ["fetch", "origin"]);
    // Check out the requested branch. If it doesn't exist locally yet
    // (e.g. the implement flow created it on a different iteration
    // and we're a review-fix flow on a refreshed clone), pull it from
    // origin. Use `-B` to switch even if currently on a different ref.
    git(checkoutDir, ["checkout", "-B", branch, `origin/${branch}`]);
  } else {
    mkdirSync(checkoutDir, { recursive: true });
    const cloneArgs = ["-c", `credential.helper=${HELPER_SNIPPET}`, "clone"];
    if (fromBranch) {
      cloneArgs.push("--branch", fromBranch);
    }
    cloneArgs.push(cleanUrl, ".");
    try {
      git(checkoutDir, cloneArgs);
      // If branch == fromBranch (review-fix cloning the existing PR
      // branch), the just-cloned ref already IS that branch — `-b`
      // would error. Otherwise create the new branch off whatever
      // ref clone landed on (= fromBranch or repo default).
      if (fromBranch && branch === fromBranch) {
        git(checkoutDir, ["checkout", branch]);
      } else {
        git(checkoutDir, ["checkout", "-b", branch]);
      }
      git(checkoutDir, ["config", "credential.helper", HELPER_SNIPPET]);
    } catch (err) {
      // Best-effort cleanup of the half-built dir before bubbling.
      try {
        rmSync(checkoutDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  let priorSession: { kind: string; id: string } | null = null;
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

  process.stdout.write(
    `${JSON.stringify({
      workdir: checkoutDir,
      branch,
      sessionDir,
      priorSession,
    })}\n`,
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
  // an injected --session-dir that aims at $HOME or /etc.
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
  // New shape: --key <slug> nukes both ~/.opencara/work/<key>/ AND
  // ~/.opencara/sessions/<key>/. Used by the orchestrator's
  // pull_request.closed handler. Idempotent (missing dirs = success).
  const rawKey = pickFlag(args, "--key");
  if (!rawKey) {
    fail("worktree remove requires --key <slug>");
  }
  const key = safeKey(rawKey);
  if (!key) fail(`invalid --key '${rawKey}'`);

  // Ensure the root exists so realpathSync doesn't ENOENT on a fresh
  // device, then sandbox: removed paths must resolve under
  // ~/.opencara/. Defends against a typo'd --key that escapes via ..
  // or symlinks.
  mkdirSync(OPENCARA_ROOT, { recursive: true });
  const opencaraRoot = realpathSync(OPENCARA_ROOT);

  for (const subtreeRoot of [WORK_ROOT, SESSION_ROOT]) {
    const target = join(subtreeRoot, key);
    if (!existsSync(target)) continue;
    let resolved: string;
    try {
      resolved = realpathSync(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      fail(`worktree remove: cannot resolve ${target}: ${(err as Error).message}`);
    }
    // Safety: must live under ~/.opencara/. Defends against a typo'd
    // --key that would resolve outside the root via .. or symlinks.
    if (!resolved.startsWith(opencaraRoot + sep)) {
      fail(`worktree remove: refuses to remove ${resolved} (not under ${opencaraRoot})`);
    }
    rmSync(resolved, { recursive: true, force: true });
  }
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
