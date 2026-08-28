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
  statSync,
  writeFileSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

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
  // Platform-neutral overrides, both optional so an older orchestrator that
  // sends neither keeps the exact GitHub behaviour this command shipped with.
  //
  // --clone-url: full HTTPS remote. Azure DevOps repos are three segments
  //   (org/project/_git/repo), which `--repo OWNER/NAME` cannot express.
  // --auth-user: username half of the basic-auth pair. GitHub requires the
  //   literal "x-access-token"; Azure DevOps accepts any non-empty value.
  const cloneUrlFlag = pickFlag(args, "--clone-url");
  const authUser = pickFlag(args, "--auth-user") ?? "x-access-token";

  if (!branch) {
    fail("worktree create requires --branch <name>");
  }
  if (!repo && !cloneUrlFlag) {
    fail("worktree create requires --repo OWNER/NAME or --clone-url <url>");
  }
  if (!rawKey) {
    fail("worktree create requires --key <slug>");
  }
  // Only validate --repo's shape when it is the thing we'll build a URL from.
  // With --clone-url present, --repo is just a label (Azure DevOps sends
  // "org/project" there, which has its own segment count).
  if (!cloneUrlFlag && repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    fail(`invalid --repo '${repo}' (expected OWNER/NAME)`);
  }
  if (cloneUrlFlag && !/^https:\/\/[\w.-]+\//.test(cloneUrlFlag)) {
    // Reject non-HTTPS and anything that isn't a plain URL: this value ends up
    // in a `git clone` argv, so a `--upload-pack=...`-shaped string here would
    // be an argument-injection vector.
    fail(`invalid --clone-url '${cloneUrlFlag}' (expected an https:// URL)`);
  }
  if (!/^[\w.-]+$/.test(authUser)) {
    fail("--auth-user contains unexpected characters; refusing to use");
  }
  // OPENCARA_SCM_TOKEN is the platform-neutral name; GH_TOKEN stays supported
  // because every currently-deployed orchestrator injects that one, and agents
  // in existing prompts reference it by name.
  const token = process.env["OPENCARA_SCM_TOKEN"] ?? process.env["GH_TOKEN"];
  if (!token) {
    fail(
      "worktree create needs GH_TOKEN or OPENCARA_SCM_TOKEN in env (the orchestrator injects this per run)",
    );
  }
  // Sanity-check the token shape so a fat-fingered env doesn't smuggle
  // shell metachars into the credential helper string before it lands in
  // a `git -c` value.
  //
  // `.` IS allowed: GitHub is rolling out a second installation-token
  // format alongside the classic 40-char `ghs_`+alphanumerics one — a
  // ~390-char `ghs_<48>.<254>.<86>` (three dot-separated segments,
  // JWT-shaped). Both authenticate fine, and which one you get varies
  // per mint call, so an alphanumerics-only guard rejected a growing
  // random ~4%+ of otherwise-valid runs (flow run 01KYS8NYV68M2P2TAP1K97AFAJ:
  // "worktree allocation ... GH_TOKEN contains unexpected characters").
  //
  // This is defense-in-depth, not a correctness requirement: HELPER_SNIPPET
  // below references the token by NAME ($OPENCARA_SCM_TOKEN), so the value
  // never reaches argv or .git/config. Whitespace, quotes, $ and backticks —
  // the characters that would actually matter — stay rejected.
  //
  // Microsoft Entra access tokens (Azure DevOps) are JWTs: three base64url
  // segments separated by `.`, so they pass the same guard. base64url uses
  // only [A-Za-z0-9_-], all within [\w.-].
  if (!/^[\w.-]+$/.test(token)) {
    fail("SCM token contains unexpected characters; refusing to use");
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
  // which is the natural cache layout. `repo` is a label under --clone-url,
  // so fall back to the key when it's absent.
  const cacheDir = useCache ? join(CACHE_ROOT, safeKey(repo || rawKey)) : null;
  const baseGitEnv: NodeJS.ProcessEnv = { ...process.env };
  // Normalize onto one variable name so the helper snippet below has a single
  // thing to reference regardless of which one the orchestrator injected.
  baseGitEnv["OPENCARA_SCM_TOKEN"] = token;
  const gitEnv: NodeJS.ProcessEnv | undefined =
    useCache && !useLfs
      ? { ...baseGitEnv, GIT_LFS_SKIP_SMUDGE: "1" }
      : baseGitEnv;

  // The credential helper is a single-quoted shell snippet that git
  // execs via /bin/sh on auth challenge. It references the token by
  // NAME — the value never enters argv (process listings) or
  // .git/config. Installed inline at clone time AND persisted in the
  // worktree's .git/config so a downstream `git push`/`git fetch`
  // also picks up the agent's per-run token.
  //
  // The username differs by platform (GitHub demands the literal
  // "x-access-token"; Azure DevOps accepts anything), so it is interpolated —
  // safe because --auth-user is validated against [\w.-] above.
  const HELPER_SNIPPET =
    `!f() { echo username=${authUser}; echo "password=$OPENCARA_SCM_TOKEN"; }; f`;
  const cleanUrl = cloneUrlFlag ?? `https://github.com/${repo}.git`;

  mkdirSync(sessionDir, { recursive: true });

  // Refresh the shared cache first (if enabled) so the per-key
  // checkout's `--reference` clone borrows up-to-date packs. Without
  // this, the cache could serve stale objects and the per-key fetch
  // would have to download anything newer over the network anyway.
  //
  // Cache-prep is serialized via flock(2) on a sibling lockfile so a PM
  // wave that fans out N issue-implement runs against this host doesn't
  // race on `refs/remotes/origin/*` updates inside the shared cache (git
  // fetch fails fast with "cannot lock ref" when concurrent processes
  // both try to advance a ref). The kernel releases the lock on any
  // process exit — including SIGKILL — so crashed allocators cannot
  // poison the lockfile. Lock is per-cacheDir, so different repos still
  // proceed in parallel.
  if (cacheDir) {
    const cacheLockPath = `${cacheDir}.lock`;
    mkdirSync(dirname(cacheLockPath), { recursive: true });

    if (existsSync(join(cacheDir, ".git"))) {
      gitLocked(cacheDir, ["fetch", "--all", "--prune"], cacheLockPath, gitEnv);
    } else {
      mkdirSync(cacheDir, { recursive: true });
      try {
        // No --branch: cache holds all refs so any PR branch can be
        // borrowed from it.
        gitLocked(
          cacheDir,
          ["-c", `credential.helper=${HELPER_SNIPPET}`, "clone", cleanUrl, "."],
          cacheLockPath,
          gitEnv,
        );
        gitLocked(
          cacheDir,
          ["config", "credential.helper", HELPER_SNIPPET],
          cacheLockPath,
        );
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
      gitLocked(cacheDir, ["lfs", "fetch", "--all"], cacheLockPath, gitEnv);
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
  // Everything from here to the end of the clone below mutates one
  // shared directory, so it runs under the per-key allocation lock.
  const releaseCheckoutLock = acquireCheckoutLock(`${checkoutDir}.lock`);

  let reused = false;
  // Probe `.git/HEAD`, not `.git/`: `git clone` creates `.git/` early and
  // fills it in incrementally, with HEAD landing near the end — so a
  // crashed clone leaves behind a `.git/` that no amount of in-place
  // repair can salvage. Every command against it dies with "ambiguous
  // argument 'HEAD'", which is exactly the state that opened flow run
  // 01M13SNSCY6YTFANP1SPEC7TM0. Treating that as "no checkout" sends it
  // straight down the wipe-and-clone path instead of running the repair
  // sequence on rubble. Same probe the cache TOCTOU guard above uses.
  if (existsSync(join(checkoutDir, ".git", "HEAD"))) {
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
      // The whole point of this catch is that a bad iteration can't
      // permanently poison the key — so a throwing rm defeats it
      // entirely. Unguarded, it escaped as an unhandled exception and
      // took the allocation down with a message about the cleanup
      // rather than the actual problem (flow run
      // 01M13SNHM4Y4JGTY4HPKVXW32X: "ENOTEMPTY: rmdir …/checkout/.git").
      try {
        rmDir(checkoutDir);
      } catch (rmErr) {
        fail(
          `worktree create: could not clear ${checkoutDir} for re-clone ` +
            `(${(rmErr as Error).message})`,
        );
      }
    }
  } else if (existsSync(checkoutDir)) {
    // No usable `.git/HEAD` but the dir exists (a half-built clone from
    // a crashed prior run) — wipe so the clone below doesn't trip
    // on stale files.
    rmDir(checkoutDir);
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
        rmDir(checkoutDir);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  releaseCheckoutLock();

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

// How long a contender waits for the per-key allocation lock before
// giving up. Generous on purpose: the holder may be doing a cold clone
// of a large repo, and waiting is always cheaper than the corruption
// that racing produces.
const LOCK_TIMEOUT_MS = 15 * 60_000;
// Last-resort escape hatch: a lock this old is broken even if its owner
// still looks alive, so a wedged allocator — or a dead one whose pid the
// OS has since handed to an unrelated process — can't poison a key
// forever. Deliberately well beyond both LOCK_TIMEOUT_MS and any
// plausible clone, because breaking a lock someone is genuinely holding
// re-creates the very race this lock exists to prevent.
const LOCK_STALE_MS = 60 * 60_000;
const LOCK_POLL_MS = 100;
// Covers the window between mkdir'ing the lock and writing the owner pid
// into it, so a lock taken microseconds ago is never mistaken for one
// whose holder died before it could identify itself.
const LOCK_GRACE_MS = 5_000;

/**
 * `rm -rf` that tolerates a racing writer inside the tree.
 *
 * Node only retries ENOTEMPTY/EBUSY/EPERM when `maxRetries` is set; at
 * the default of 0, a single file appearing while `rm` walks the
 * directory is enough to make removal throw.
 */
function rmDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * Block the thread for `ms`. The allocation path is `execFileSync` from
 * end to end, so a lock wait has to block too — `Atomics.wait` is the
 * only synchronous sleep Node offers.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True while the process that took `lockPath` is still running. */
function lockOwnerAlive(lockPath: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(join(lockPath, "owner"), "utf8").trim(), 10);
  } catch {
    // No owner file: a lock from an older CLI, or one whose holder died
    // between the mkdir and the write. The grace window below is what
    // keeps this from stealing a lock taken microseconds ago.
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    // Only ESRCH is proof the holder is gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockIsStale(lockPath: string): boolean {
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return false; // Vanished — the next acquire attempt just takes it.
  }
  if (ageMs < LOCK_GRACE_MS) return false;
  return !lockOwnerAlive(lockPath) || ageMs > LOCK_STALE_MS;
}

/**
 * Take the exclusive allocation lock for one per-key checkout, returning
 * the release callback.
 *
 * A single flow run fans sibling agent nodes out in parallel (two
 * reviewers on the same PR, say), and they share one worktree key — so
 * two `worktree create` processes routinely open on the same checkout
 * directory in the same millisecond. Unserialized they destroy each
 * other, both ways seen in production on 2026-08-28:
 *
 *   1. Both take the repair path and both `rm -rf` the tree; whichever
 *      loses the walk race dies on `ENOTEMPTY: rmdir …/checkout/.git`
 *      (flow run 01M13SNHM4Y4JGTY4HPKVXW32X).
 *   2. One re-creates the directory and starts `git clone` in it while
 *      the other's `rm -rf` deletes that directory underneath — the
 *      clone's own cwd disappears mid-flight ("sh: 0: getcwd() failed",
 *      "could not lock config file …/.git/config") (flow run
 *      01M13SNSCY6YTFANP1SPEC7TM0).
 *
 * Cache-prep next door serializes with flock(1), but that binary ships
 * with util-linux and is absent from a stock macOS — tolerable there
 * because `--cache-repo` is opt-in, and not tolerable here because every
 * allocation on every host takes this path. So the lock is built on the
 * one primitive every platform makes atomic: mkdir(2). The cost is that
 * the kernel won't drop it for us, hence the staleness probe above and
 * the exit hook below.
 */
function acquireCheckoutLock(lockPath: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      // Deliberately non-recursive: `mkdir` of an existing path is the
      // atomic test-and-set this whole lock rests on.
      mkdirSync(lockPath);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (Date.now() > deadline) {
      fail(
        `worktree create: gave up after ${Math.round(LOCK_TIMEOUT_MS / 60_000)}m ` +
          `waiting for the allocation lock at ${lockPath} — if no other ` +
          `'opencara internal worktree create' is running on this host, ` +
          `remove that directory`,
      );
    }
    if (lockIsStale(lockPath)) {
      try {
        rmDir(lockPath);
      } catch {
        // A live contender may have re-taken it in the meantime; the
        // next iteration re-evaluates rather than forcing the issue.
      }
    }
    sleepSync(LOCK_POLL_MS);
  }

  // Advisory: identifies us to the staleness probe. Best-effort — a lock
  // with no readable owner is treated as dead once past the grace window,
  // which is the safe direction to fail.
  try {
    writeFileSync(join(lockPath, "owner"), `${process.pid}\n`);
  } catch {
    /* ignore */
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      rmDir(lockPath);
    } catch {
      // Leave it to the staleness probe rather than failing an
      // allocation that has otherwise succeeded.
    }
  };
  // `fail()` calls process.exit, which skips `finally` blocks, and a
  // thrown error exits too — the exit hook is what makes sure neither
  // path strands the lock. A SIGKILL still can, which is precisely what
  // the staleness probe is for.
  process.once("exit", release);
  return () => {
    process.removeListener("exit", release);
    release();
  };
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

// Run `git <args>` under an exclusive flock(2) on `lockPath`. Concurrent
// processes block on the lockfile (no spin, no retry budget); the kernel
// releases the lock on process death so a crashed allocator can't poison
// it. Used to serialize cache-prep operations against the same shared
// cache repo across parallel worktree allocations.
function gitLocked(
  cwd: string,
  args: string[],
  lockPath: string,
  env?: NodeJS.ProcessEnv,
): void {
  execFileSync(
    "flock",
    ["--exclusive", lockPath, "git", ...args],
    {
      cwd,
      stdio: ["ignore", "ignore", "inherit"],
      env: env ?? process.env,
    },
  );
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
