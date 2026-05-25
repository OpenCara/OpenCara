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
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

const OPENCARA_ROOT = join(homedir(), ".opencara");
// Per-PR-branch trees are siblings under ~/.opencara/. Both keyed by
// the same `--key <slug>`. The orchestrator's pull_request.closed
// handler dispatches `worktree remove` to wipe both for that key.
const WORK_ROOT = join(OPENCARA_ROOT, "work");
const SESSION_ROOT = join(OPENCARA_ROOT, "sessions");
// Opt-in shared-object cache. One clone per repo (NOT per branch),
// reused across every per-PR-branch checkout via `git clone
// --reference`. Lives outside WORK_ROOT so `worktree remove` (which
// is keyed per-branch) leaves it intact across PR closes.
const CACHE_ROOT = join(OPENCARA_ROOT, "cache");

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

  // Optional shared object cache. `--cache-repo` enables; `--lfs`
  // additionally pulls LFS blobs into the cache and shares them with
  // checkouts via a symlink. When caching is ON and LFS is OFF we set
  // GIT_LFS_SKIP_SMUDGE=1 so clones/fetches don't pay the LFS-blob
  // download cost. When caching is OFF we leave the env alone — that
  // preserves pre-cache behaviour for every flow that doesn't opt in
  // (so an LFS repo on a non-cached flow still smudges normally).
  const useCache = hasFlag(args, "--cache-repo");
  const useLfs = hasFlag(args, "--lfs");
  if (useLfs && !useCache) {
    fail("--lfs requires --cache-repo");
  }
  if (useLfs && !hasGitLfs()) {
    // Pre-flight so the operator-facing error names the missing tool
    // and the host, instead of the cryptic stderr from a downstream
    // `git lfs fetch` (which prints "git: 'lfs' is not a git command").
    fail(
      "--lfs is set but git-lfs is not installed on this host — " +
        "install it (e.g. `apt install git-lfs && git lfs install`) " +
        "or disable LFS on the agent.worktree.cacheRepo config",
    );
  }
  // safeKey takes "owner/name" → "owner/name" (segments sanitized),
  // which is the natural cache layout.
  const cacheDir = useCache ? join(CACHE_ROOT, safeKey(repo)) : null;
  const gitEnv: NodeJS.ProcessEnv | undefined =
    useCache && !useLfs
      ? { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" }
      : undefined;

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

  // Refresh the shared cache first (if enabled) so the per-key
  // checkout's `--reference` clone borrows up-to-date packs. Without
  // this, the cache could serve stale objects and the per-key fetch
  // would have to download anything newer over the network anyway.
  if (cacheDir) {
    if (existsSync(join(cacheDir, ".git"))) {
      git(cacheDir, ["fetch", "--all", "--prune"], gitEnv);
    } else {
      mkdirSync(cacheDir, { recursive: true });
      try {
        // No --branch: cache holds all refs so any PR branch can be
        // borrowed from it.
        git(
          cacheDir,
          ["-c", `credential.helper=${HELPER_SNIPPET}`, "clone", cleanUrl, "."],
          gitEnv,
        );
        git(cacheDir, ["config", "credential.helper", HELPER_SNIPPET]);
      } catch (err) {
        try {
          // TOCTOU guard: a concurrent `worktree create` for a
          // different branch of the same repo can also have decided
          // the cache was missing and started cloning into the same
          // dir. If `.git/HEAD` exists, *some* clone reached enough
          // state to be useful — don't nuke it from under the other
          // process. Plain `existsSync(.git)` isn't enough because
          // `git clone` creates `.git/` early but populates it
          // incrementally; HEAD lands near the end of init.
          if (!existsSync(join(cacheDir, ".git", "HEAD"))) {
            rmSync(cacheDir, { recursive: true, force: true });
          }
        } catch {
          /* ignore */
        }
        throw err;
      }
    }
    if (useLfs) {
      // Populate cacheDir/.git/lfs/objects so per-key checkouts can
      // share blobs via the symlink below. `git lfs fetch` no-ops
      // (and doesn't create the dir) when the repo has zero LFS
      // history, so mkdirSync ourselves before the symlink lands.
      git(cacheDir, ["lfs", "fetch", "--all"], gitEnv);
      mkdirSync(join(cacheDir, ".git", "lfs", "objects"), { recursive: true });
    }
  }

  // Idempotent allocation. The implement flow on first run does the
  // clone; every subsequent flow run on the same (repo, branch) finds
  // the .git/ already there, skips the clone, fetches latest, and
  // checks out the branch. Removed only when the orchestrator's
  // pull_request.closed handler dispatches `worktree remove`.
  //
  // The checkout is an orchestrator-owned scratch space — between
  // flow runs the working tree state is meaningless (we're about to
  // fetch and switch branches), so we open with `reset --hard HEAD`
  // and `clean -fdx` to recover from corruption that prior runs may
  // have left behind. The specific case that motivated this: a prior
  // run died with `.git/index` gone (manual recovery attempt after
  // an agent crash), which made every subsequent `git checkout
  // <branch>` refuse with "untracked working tree files would be
  // overwritten" and poison the per-(repo, branch) key until someone
  // `rm -rf`d it by hand. The reset rebuilds the index, the clean
  // removes stale debris. If even those fail (broken HEAD or partial
  // objects/), the outer catch nukes the dir and falls through to
  // the fresh-clone path.
  let reused = false;
  if (existsSync(join(checkoutDir, ".git"))) {
    try {
      git(checkoutDir, ["reset", "--hard", "HEAD"], gitEnv);
      git(checkoutDir, ["clean", "-fdx"], gitEnv);
      git(checkoutDir, ["fetch", "origin"], gitEnv);
      // Three cases:
      //   1. `origin/<branch>` exists — reset our local copy to track it.
      //      Used by review-fix flows re-allocating on a refreshed clone.
      //   2. Local `<branch>` exists but origin doesn't — a prior run on
      //      this same checkout created the branch and never pushed (e.g.
      //      a synthesizer that writes locally and is then re-run). Just
      //      switch to it. Pre-fix this path blindly did `checkout -B
      //      <branch> origin/<branch>` and exploded on the missing remote.
      //   3. Neither — fall back to `--from-branch` (or fail loud) so we
      //      don't silently corrupt state by checking out HEAD as the
      //      new branch.
      if (refExists(checkoutDir, `refs/remotes/origin/${branch}`)) {
        git(checkoutDir, ["checkout", "-B", branch, `origin/${branch}`], gitEnv);
      } else if (refExists(checkoutDir, `refs/heads/${branch}`)) {
        git(checkoutDir, ["checkout", branch], gitEnv);
      } else if (fromBranch) {
        git(checkoutDir, ["checkout", "-B", branch, `origin/${fromBranch}`], gitEnv);
      } else {
        fail(
          `worktree create: '${branch}' missing locally and on origin/, no --from-branch to fall back to`,
        );
      }
      reused = true;
    } catch (err) {
      // Reuse + in-place repair both failed (irrecoverable: broken
      // HEAD, partial objects/, etc). Nuke the dir and fall through
      // to fresh clone so a bad iteration doesn't permanently poison
      // this key. Worst case is a slower-than-usual run.
      console.warn(
        `[worktree] reuse of ${checkoutDir} failed (${
          (err as Error).message
        }); re-cloning`,
      );
      rmSync(checkoutDir, { recursive: true, force: true });
    }
  } else if (existsSync(checkoutDir)) {
    // `.git/` is missing but the dir exists (a half-built clone from
    // a crashed prior run) — wipe so the clone below doesn't trip
    // on stale files.
    rmSync(checkoutDir, { recursive: true, force: true });
  }
  if (!reused) {
    mkdirSync(checkoutDir, { recursive: true });
    const cloneArgs = ["-c", `credential.helper=${HELPER_SNIPPET}`, "clone"];
    if (cacheDir) {
      // `--no-checkout` so we can install the LFS objects symlink
      // BEFORE the working tree is materialized — otherwise the
      // initial checkout's smudge filter would miss the shared
      // blobs and re-download them.
      cloneArgs.push("--no-checkout", "--reference", cacheDir);
    }
    if (fromBranch) {
      cloneArgs.push("--branch", fromBranch);
    }
    cloneArgs.push(cleanUrl, ".");
    try {
      git(checkoutDir, cloneArgs, gitEnv);
      if (cacheDir && useLfs) {
        // Share the cache's LFS object store with this checkout. Plain
        // --reference covers git objects but NOT LFS blobs (which live
        // under .git/lfs, not .git/objects). Symlinking the directory
        // means a subsequent `git lfs pull` here is a no-op for any
        // blob the cache already has.
        const checkoutLfsDir = join(checkoutDir, ".git", "lfs");
        mkdirSync(checkoutLfsDir, { recursive: true });
        symlinkSync(
          join(cacheDir, ".git", "lfs", "objects"),
          join(checkoutLfsDir, "objects"),
        );
      }
      // If branch == fromBranch (review-fix cloning the existing PR
      // branch), the just-cloned ref already IS that branch — `-b`
      // would error. Otherwise create the new branch off whatever
      // ref clone landed on (= fromBranch or repo default).
      if (fromBranch && branch === fromBranch) {
        git(checkoutDir, ["checkout", branch], gitEnv);
      } else {
        git(checkoutDir, ["checkout", "-b", branch], gitEnv);
      }
      git(checkoutDir, ["config", "credential.helper", HELPER_SNIPPET], gitEnv);
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

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): void {
  // Inherit stderr so git's own error lines reach the agent_runs log,
  // making 401/404/branch-not-found easy to diagnose.
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "inherit"],
    env: env ?? process.env,
  });
}

/**
 * Check whether a ref (branch, tag, remote-tracking ref) resolves in
 * `cwd`. Returns false on any non-zero exit — `git rev-parse --verify`
 * also fails for malformed refs, which is the same "not present" answer
 * the caller wants.
 */
function refExists(cwd: string, ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function hasGitLfs(): boolean {
  try {
    execFileSync("git", ["lfs", "version"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function pickFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.indexOf(name) !== -1;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
