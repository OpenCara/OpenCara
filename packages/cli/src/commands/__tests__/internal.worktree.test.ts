// Regression: when `opencara internal worktree create` is re-run on a
// checkout where a prior run created the requested branch LOCALLY but
// never pushed it, the existing-checkout path used to blindly do
// `git checkout -B <branch> origin/<branch>` and explode with:
//
//   fatal: 'origin/<branch>' is not a commit and a branch '<branch>'
//   cannot be created from it
//
// This hits any iterative flow whose agent commits locally (e.g. a
// review-synthesizer rerun on the same PR). The fix tries the remote
// tracking ref first, falls back to the local ref, then to fromBranch.
//
// Drives the actual CLI (`node --import tsx src/bin.ts internal …`)
// against a local-bare "origin" so no network is needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
// __tests__/internal.worktree.test.ts → ../bin.ts (packages/cli/src/bin.ts)
const binSrc = join(here, "..", "..", "..", "bin.ts");

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

function runInternal(env: NodeJS.ProcessEnv, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    "node",
    ["--import", "tsx", binSrc, "internal", ...args],
    { env, encoding: "utf8" },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("internal worktree create — existing-checkout branch resolution", () => {
  it("re-uses a local branch when origin doesn't have it (regression: no-remote)", () => {
    const root = mkdtempSync(join(tmpdir(), "opencara-wt-noremote-"));
    try {
      const home = join(root, "home");
      mkdirSync(join(home, ".opencara", "work"), { recursive: true });
      mkdirSync(join(home, ".opencara", "sessions"), { recursive: true });

      // Bare "origin" with just `main`.
      const origin = join(root, "origin.git");
      execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], {
        stdio: "ignore",
      });

      // Seed origin/main with one commit.
      const seed = join(root, "seed");
      mkdirSync(seed);
      git(seed, ["init", "--initial-branch=main"]);
      git(seed, ["config", "user.email", "t@example.com"]);
      git(seed, ["config", "user.name", "t"]);
      writeFileSync(join(seed, "README"), "hi\n");
      git(seed, ["add", "."]);
      git(seed, ["commit", "-m", "init"]);
      git(seed, ["remote", "add", "origin", origin]);
      git(seed, ["push", "origin", "main"]);

      // Pre-seed the checkout dir as a clone, then create a local-only
      // branch (the post-synthesizer state we want to test).
      const repo = "talespark-git/bank-heist";
      const branch = "opencara/pr-test";
      const key = "talespark-git/bank-heist/branch-opencara_pr-test";
      const checkout = join(home, ".opencara", "work", key, "checkout");
      mkdirSync(checkout, { recursive: true });
      git(checkout, ["clone", origin, "."]);
      git(checkout, ["config", "user.email", "t@example.com"]);
      git(checkout, ["config", "user.name", "t"]);
      git(checkout, ["checkout", "-b", branch]);
      writeFileSync(join(checkout, "syn.txt"), "synthesized\n");
      git(checkout, ["add", "."]);
      git(checkout, ["commit", "-m", "synth output (local only)"]);

      const r = runInternal(
        { ...process.env, HOME: home, GH_TOKEN: "ghs_test123" },
        [
          "worktree", "create",
          "--repo", repo,
          "--branch", branch,
          "--from-branch", "main",
          "--key", key,
        ],
      );

      assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
      const last = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
      const payload = JSON.parse(last) as { workdir: string; branch: string };
      assert.equal(payload.branch, branch);
      assert.equal(payload.workdir, checkout);
      // Verify we ended up actually checked out on the local branch.
      const head = execFileSync("git", ["-C", checkout, "branch", "--show-current"], {
        encoding: "utf8",
      }).trim();
      assert.equal(head, branch);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers from a corrupted checkout (missing .git/index + stale untracked) in place", () => {
    // Regression: when a prior run left a partially-broken checkout
    // (`.git/` present, `.git/index` gone) every subsequent allocate
    // bombed with "untracked working tree files would be overwritten
    // by checkout … Aborting", because indexless git treats every
    // tracked file as untracked and refuses to overwrite on branch
    // switch. The bad checkout poisoned the per-(repo, branch) key
    // until someone `rm -rf`d it by hand. Allocate now opens the
    // reuse path with `reset --hard HEAD && clean -fdx` to recover
    // in place.
    //
    // Mirrors the production state of flow run
    // 01KSF2XZDS6VKNA72JB0BBA5GY on 2026-05-25 (issue OpenCara#114).
    const root = mkdtempSync(join(tmpdir(), "opencara-wt-corrupt-"));
    try {
      const home = join(root, "home");
      mkdirSync(join(home, ".opencara", "work"), { recursive: true });
      mkdirSync(join(home, ".opencara", "sessions"), { recursive: true });

      const origin = join(root, "origin.git");
      execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], {
        stdio: "ignore",
      });

      const seed = join(root, "seed");
      mkdirSync(seed);
      git(seed, ["init", "--initial-branch=main"]);
      git(seed, ["config", "user.email", "t@example.com"]);
      git(seed, ["config", "user.name", "t"]);
      writeFileSync(join(seed, "README"), "hi\n");
      git(seed, ["add", "."]);
      git(seed, ["commit", "-m", "init"]);
      git(seed, ["remote", "add", "origin", origin]);
      git(seed, ["push", "origin", "main"]);

      const repo = "owner/name";
      const branch = "opencara/issue-114";
      const key = "owner/name/branch-opencara_issue-114";
      const checkout = join(home, ".opencara", "work", key, "checkout");
      mkdirSync(checkout, { recursive: true });
      git(checkout, ["clone", origin, "."]);
      git(checkout, ["config", "user.email", "t@example.com"]);
      git(checkout, ["config", "user.name", "t"]);
      git(checkout, ["checkout", "-b", branch]);

      // Reproduce the broken state: nuke the index AND drop an
      // untracked file that would conflict if the allocator tried a
      // naive `git checkout` (which is what used to happen).
      rmSync(join(checkout, ".git", "index"));
      writeFileSync(join(checkout, "stale-agent-debris.txt"), "leftover\n");

      const r = runInternal(
        { ...process.env, HOME: home, GH_TOKEN: "ghs_test123" },
        [
          "worktree", "create",
          "--repo", repo,
          "--branch", branch,
          "--from-branch", "main",
          "--key", key,
        ],
      );

      assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
      const last = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
      const payload = JSON.parse(last) as { workdir: string; branch: string };
      assert.equal(payload.branch, branch);
      assert.equal(payload.workdir, checkout);
      // Index restored, untracked debris gone, status clean, still on branch.
      const head = execFileSync("git", ["-C", checkout, "branch", "--show-current"], {
        encoding: "utf8",
      }).trim();
      assert.equal(head, branch);
      const porcelain = execFileSync(
        "git",
        ["-C", checkout, "status", "--porcelain"],
        { encoding: "utf8" },
      );
      assert.equal(porcelain, "", `expected clean status post-recovery, got:\n${porcelain}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers origin/<branch> when it exists (no regression in the common path)", () => {
    const root = mkdtempSync(join(tmpdir(), "opencara-wt-remote-"));
    try {
      const home = join(root, "home");
      mkdirSync(join(home, ".opencara", "work"), { recursive: true });
      mkdirSync(join(home, ".opencara", "sessions"), { recursive: true });

      const origin = join(root, "origin.git");
      execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], {
        stdio: "ignore",
      });

      // Push BOTH main and feature-branch to origin so the remote-tracking
      // ref exists when worktree create re-allocates.
      const seed = join(root, "seed");
      mkdirSync(seed);
      git(seed, ["init", "--initial-branch=main"]);
      git(seed, ["config", "user.email", "t@example.com"]);
      git(seed, ["config", "user.name", "t"]);
      writeFileSync(join(seed, "README"), "hi\n");
      git(seed, ["add", "."]);
      git(seed, ["commit", "-m", "init"]);
      git(seed, ["remote", "add", "origin", origin]);
      git(seed, ["push", "origin", "main"]);
      git(seed, ["checkout", "-b", "feature/x"]);
      writeFileSync(join(seed, "x.txt"), "x\n");
      git(seed, ["add", "."]);
      git(seed, ["commit", "-m", "x"]);
      git(seed, ["push", "origin", "feature/x"]);

      const repo = "owner/name";
      const branch = "feature/x";
      const key = "owner/name/branch-feature_x";
      const checkout = join(home, ".opencara", "work", key, "checkout");
      mkdirSync(checkout, { recursive: true });
      git(checkout, ["clone", origin, "."]);

      const r = runInternal(
        { ...process.env, HOME: home, GH_TOKEN: "ghs_test123" },
        [
          "worktree", "create",
          "--repo", repo,
          "--branch", branch,
          "--from-branch", "main",
          "--key", key,
        ],
      );
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
      const head = execFileSync("git", ["-C", checkout, "branch", "--show-current"], {
        encoding: "utf8",
      }).trim();
      assert.equal(head, branch);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Regression: a PM-wave fanout of N issue-implement runs against the
// same host all hit `~/.opencara/cache/<owner>/<repo>` simultaneously
// and raced on `git fetch --all --prune` ref locking. N-1 of them
// exited with "error: cannot lock ref 'refs/remotes/origin/main': is at
// <sha> but expected <other-sha>". The fix serializes cache-prep on a
// per-cacheDir flock; this test fans out 4 parallel allocations against
// a freshly seeded cache and asserts all succeed.
//
// Production repro: flow run 01KSM020YVZFMV54XGFSQXF1VR + 3 siblings
// from wave 01KSM02086TSF4Z60B448F085M.
function runInternalAsync(
  env: NodeJS.ProcessEnv,
  args: string[],
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      ["--import", "tsx", binSrc, "internal", ...args],
      { env },
    );
    let stderr = "";
    child.stderr?.on("data", (b) => {
      stderr += b.toString();
    });
    child.stdout?.on("data", () => {
      /* drain */
    });
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

describe("internal worktree create — concurrent cache-prep", () => {
  it("serializes parallel allocations against the same cache repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencara-wt-conc-"));
    try {
      const home = join(root, "home");
      mkdirSync(join(home, ".opencara", "work"), { recursive: true });
      mkdirSync(join(home, ".opencara", "sessions"), { recursive: true });
      mkdirSync(join(home, ".opencara", "cache"), { recursive: true });

      // Bare "origin" seeded with main + a feature branch per fanned-out
      // run, so the per-key checkout has something distinct to land on.
      const origin = join(root, "origin.git");
      execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], {
        stdio: "ignore",
      });

      const seed = join(root, "seed");
      mkdirSync(seed);
      git(seed, ["init", "--initial-branch=main"]);
      git(seed, ["config", "user.email", "t@example.com"]);
      git(seed, ["config", "user.name", "t"]);
      writeFileSync(join(seed, "README"), "hi\n");
      git(seed, ["add", "."]);
      git(seed, ["commit", "-m", "init"]);
      git(seed, ["remote", "add", "origin", origin]);
      git(seed, ["push", "origin", "main"]);

      // Pre-warm the cache so all parallel runs land in the fetch
      // branch (the failure path from production), not the clone
      // branch. Then push extra commits so each parallel fetch has
      // refs to advance — increasing the odds of a ref-lock collision
      // without the flock fix.
      const repo = "octo/repo";
      const cacheDir = join(home, ".opencara", "cache", repo);
      execFileSync(
        "git",
        ["clone", origin, cacheDir],
        { stdio: "ignore" },
      );

      for (let i = 0; i < 5; i++) {
        writeFileSync(join(seed, `c${i}.txt`), `c${i}\n`);
        git(seed, ["add", "."]);
        git(seed, ["commit", "-m", `c${i}`]);
      }
      git(seed, ["push", "origin", "main"]);

      // Fan out 4 parallel `worktree create --cache-repo` calls,
      // each targeting a distinct branch key.
      const N = 4;
      const branches = Array.from({ length: N }, (_, i) => `feature/x-${i}`);
      for (const br of branches) {
        // Push each branch so origin/<branch> is fetchable by the
        // per-key checkout's `git fetch origin`.
        git(seed, ["checkout", "-B", br, "main"]);
        writeFileSync(join(seed, `${br.replace(/\W/g, "_")}.txt`), "x\n");
        git(seed, ["add", "."]);
        git(seed, ["commit", "-m", `${br}`]);
        git(seed, ["push", "origin", br]);
      }

      // Pre-seed each per-key checkout dir as a clone of the local
      // origin so the CLI takes the reuse path and never reaches the
      // HTTPS clone-from-GitHub branch (which would hit the network).
      // The bug being tested lives in the cache-prep phase, which still
      // runs first regardless of the reuse path.
      for (const br of branches) {
        const key = `octo/repo/branch-${br.replace(/\W/g, "_")}`;
        const checkout = join(home, ".opencara", "work", key, "checkout");
        mkdirSync(checkout, { recursive: true });
        execFileSync("git", ["clone", origin, "."], {
          cwd: checkout,
          stdio: "ignore",
        });
      }

      const results = await Promise.all(
        branches.map((br) => {
          const key = `octo/repo/branch-${br.replace(/\W/g, "_")}`;
          return runInternalAsync(
            { ...process.env, HOME: home, GH_TOKEN: "ghs_test123" },
            [
              "worktree", "create",
              "--repo", repo,
              "--branch", br,
              "--from-branch", "main",
              "--key", key,
              "--cache-repo",
            ],
          );
        }),
      );

      const failures = results
        .map((r, i) => ({ ...r, branch: branches[i] }))
        .filter((r) => r.status !== 0);
      assert.equal(
        failures.length,
        0,
        `expected all ${N} allocations to succeed; failures:\n` +
          failures
            .map((f) => `  - ${f.branch} (exit ${f.status}): ${f.stderr.trim()}`)
            .join("\n"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Regression: a single flow run fans sibling agent nodes out in parallel
// (on 2026-08-28: "Correctness reviewer" and "Reviewer 2", started in the
// same millisecond), and both resolve the same worktree branch template —
// so two `worktree create` processes open on ONE checkout directory at
// once. Nothing serialized them, and they destroyed each other two ways:
//
//   1. Both took the repair path and both `rm -rf`'d the tree; the loser
//      of the walk race died on `ENOTEMPTY: rmdir …/checkout/.git`, which
//      escaped as an unhandled exception (flow run
//      01M13SNHM4Y4JGTY4HPKVXW32X).
//   2. One re-created the dir and started `git clone` in it while the
//      other's `rm -rf` deleted that dir underneath, so the clone's own
//      cwd vanished mid-flight: "sh: 0: getcwd() failed", "could not lock
//      config file …/.git/config" (flow run 01M13SNSCY6YTFANP1SPEC7TM0).
//
// Allocation now holds a per-key lock across the whole
// reuse-or-repair-or-clone section, so the second process waits and then
// simply reuses what the first produced.
describe("internal worktree create — concurrent same-key allocation", () => {
  // The cases below need the re-clone path to work offline. The CLI
  // builds `https://github.com/<repo>.git` itself, so point that exact
  // URL at a local bare origin with git's `insteadOf` rewrite — these
  // tests already own HOME, so a global gitconfig there is picked up.
  function seedOrigin(root: string, home: string, repo: string): string {
    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], {
      stdio: "ignore",
    });

    const seed = join(root, "seed");
    mkdirSync(seed);
    git(seed, ["init", "--initial-branch=main"]);
    git(seed, ["config", "user.email", "t@example.com"]);
    git(seed, ["config", "user.name", "t"]);
    writeFileSync(join(seed, "README"), "hi\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "init"]);
    git(seed, ["remote", "add", "origin", origin]);
    git(seed, ["push", "origin", "main"]);

    writeFileSync(
      join(home, ".gitconfig"),
      `[url "${origin}"]\n\tinsteadOf = https://github.com/${repo}.git\n`,
    );
    return origin;
  }

  const BRANCH = "opencara/pr-57";
  const KEY = "octo/repo/branch-opencara_pr-57";
  const REPO = "octo/repo";

  function allocate(home: string, extra: string[] = []) {
    return runInternalAsync(
      { ...process.env, HOME: home, GH_TOKEN: "ghs_test123" },
      [
        "worktree", "create",
        "--repo", REPO,
        "--branch", BRANCH,
        "--from-branch", "main",
        "--key", KEY,
        ...extra,
      ],
    );
  }

  /** Wraps a pending allocation so the test can ask whether it is still running. */
  function watch(pending: ReturnType<typeof allocate>) {
    const state = { done: false, result: null as Awaited<typeof pending> | null };
    const settled = pending.then((r) => {
      state.done = true;
      state.result = r;
      return r;
    });
    return { state, settled };
  }

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("waits for an allocation already in flight on the same key", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencara-wt-lockwait-"));
    try {
      const home = join(root, "home");
      mkdirSync(join(home, ".opencara", "work"), { recursive: true });
      mkdirSync(join(home, ".opencara", "sessions"), { recursive: true });
      const origin = seedOrigin(root, home, REPO);

      const checkout = join(home, ".opencara", "work", KEY, "checkout");
      mkdirSync(checkout, { recursive: true });
      git(checkout, ["clone", origin, "."]);

      // Stand in for a sibling agent node mid-allocation: take the lock
      // and name a process that is definitely alive (this test runner) as
      // its owner, so the staleness probe can't decide it's abandoned.
      const lock = `${checkout}.lock`;
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, "owner"), `${process.pid}\n`);

      const { state, settled } = watch(allocate(home));
      // Comfortably longer than an uncontended allocation against a local
      // origin (~1.5s, most of it tsx boot). Pre-fix this walked straight
      // into the held checkout and finished here.
      await wait(4000);
      assert.equal(
        state.done,
        false,
        "expected the second allocation to block while the key was locked",
      );

      rmSync(lock, { recursive: true, force: true });
      const r = await settled;
      assert.equal(r.status, 0, `expected exit 0 once released, got ${r.status}\n${r.stderr}`);
      assert.equal(existsSync(lock), false, "allocation lock leaked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("breaks a lock whose owner is gone", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencara-wt-lockstale-"));
    try {
      const home = join(root, "home");
      mkdirSync(join(home, ".opencara", "work"), { recursive: true });
      mkdirSync(join(home, ".opencara", "sessions"), { recursive: true });
      const origin = seedOrigin(root, home, REPO);

      const checkout = join(home, ".opencara", "work", KEY, "checkout");
      mkdirSync(checkout, { recursive: true });
      git(checkout, ["clone", origin, "."]);

      // A lock left behind by an allocator that was killed outright —
      // mkdir(2) locks can't be released by the kernel, so without a
      // staleness path this key would be poisoned forever.
      const dead = spawnSync("node", ["-e", ""]);
      const lock = `${checkout}.lock`;
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, "owner"), `${dead.pid}\n`);
      // Backdate past the grace window that protects a just-taken lock,
      // so the test doesn't have to sit through it.
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);

      const r = await allocate(home);
      assert.equal(r.status, 0, `expected the stale lock to be broken, got ${r.status}\n${r.stderr}`);
      assert.equal(existsSync(lock), false, "allocation lock leaked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-clones a half-built checkout (.git without HEAD) instead of repairing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencara-wt-halfclone-"));
    try {
      const home = join(root, "home");
      mkdirSync(join(home, ".opencara", "work"), { recursive: true });
      mkdirSync(join(home, ".opencara", "sessions"), { recursive: true });
      mkdirSync(join(home, ".opencara", "cache"), { recursive: true });
      seedOrigin(root, home, REPO);

      // The production precondition: a crashed earlier clone left `.git/`
      // populated enough to look like a repo but with no HEAD, so every
      // git command against it fails. Pre-fix, `existsSync('.git')` sent
      // this down the repair path — which cannot possibly work — and only
      // the failure handler got it back to a clone.
      const checkout = join(home, ".opencara", "work", KEY, "checkout");
      mkdirSync(join(checkout, ".git", "objects"), { recursive: true });
      mkdirSync(join(checkout, ".git", "refs"), { recursive: true });
      writeFileSync(
        join(checkout, ".git", "config"),
        "[core]\n\trepositoryformatversion = 0\n",
      );

      const r = await allocate(home, ["--cache-repo"]);
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stderr}`);
      assert.ok(
        !r.stderr.includes("[worktree] reuse of"),
        `expected the half-built checkout to be recognised as unusable up ` +
          `front, not sent through repair-then-recover:\n${r.stderr}`,
      );

      const head = execFileSync("git", ["-C", checkout, "branch", "--show-current"], {
        encoding: "utf8",
      }).trim();
      assert.equal(head, BRANCH);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("survives a real fan-out of allocations against one checkout", async () => {
    // End-to-end cover for the shape that produced the outage: sibling
    // agent nodes of one flow run, same branch template, same key, all
    // launched together. Timing-dependent by nature (whether they overlap
    // depends on process startup), so it backstops the deterministic
    // cases above rather than replacing them — what it does prove is that
    // the lock neither deadlocks nor leaves a corrupt tree.
    const root = mkdtempSync(join(tmpdir(), "opencara-wt-fanout-"));
    try {
      const home = join(root, "home");
      mkdirSync(join(home, ".opencara", "work"), { recursive: true });
      mkdirSync(join(home, ".opencara", "sessions"), { recursive: true });
      const origin = seedOrigin(root, home, REPO);

      const checkout = join(home, ".opencara", "work", KEY, "checkout");
      mkdirSync(checkout, { recursive: true });
      git(checkout, ["clone", origin, "."]);

      const N = 4;
      const results = await Promise.all(
        Array.from({ length: N }, () => allocate(home)),
      );

      const failures = results.filter((r) => r.status !== 0);
      assert.equal(
        failures.length,
        0,
        `expected all ${N} same-key allocations to succeed; failures:\n` +
          failures.map((f) => `  - exit ${f.status}: ${f.stderr.trim()}`).join("\n"),
      );

      const head = execFileSync("git", ["-C", checkout, "branch", "--show-current"], {
        encoding: "utf8",
      }).trim();
      assert.equal(head, BRANCH);
      assert.equal(existsSync(`${checkout}.lock`), false, "allocation lock leaked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Regression: GitHub is rolling out a second installation-token format
// alongside the classic 40-char `ghs_`+alphanumerics one — a ~390-char
// `ghs_<48>.<254>.<86>` (three dot-separated segments, JWT-shaped). Both
// authenticate fine and which one a mint returns varies per call, so the
// old alphanumerics-only guard (`/^[\w-]+$/`) rejected a growing random
// share of valid runs with "GH_TOKEN contains unexpected characters"
// (flow run 01KYS8NYV68M2P2TAP1K97AFAJ, node review_synthesizer).
describe("internal worktree create — GH_TOKEN shape validation", () => {
  // Mirrors the real shape: ghs_ + 48/254/86 dot-separated segments.
  const dottedToken =
    "ghs_" +
    "a".repeat(44) +
    "." +
    "b".repeat(254) +
    "." +
    "c".repeat(86);

  function seedOrigin(root: string): { origin: string; home: string } {
    const home = join(root, "home");
    mkdirSync(join(home, ".opencara", "work"), { recursive: true });
    mkdirSync(join(home, ".opencara", "sessions"), { recursive: true });

    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], {
      stdio: "ignore",
    });

    const seed = join(root, "seed");
    mkdirSync(seed);
    git(seed, ["init", "--initial-branch=main"]);
    git(seed, ["config", "user.email", "t@example.com"]);
    git(seed, ["config", "user.name", "t"]);
    writeFileSync(join(seed, "README"), "hi\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "init"]);
    git(seed, ["remote", "add", "origin", origin]);
    git(seed, ["push", "origin", "main"]);

    return { origin, home };
  }

  it("accepts the new dot-separated installation token format", () => {
    const root = mkdtempSync(join(tmpdir(), "opencara-wt-dottok-"));
    try {
      const { origin, home } = seedOrigin(root);

      const repo = "talespark-git/bank-heist";
      const branch = "opencara/pr-dotted";
      const key = "talespark-git/bank-heist/branch-opencara_pr-dotted";
      const checkout = join(home, ".opencara", "work", key, "checkout");
      mkdirSync(checkout, { recursive: true });
      git(checkout, ["clone", origin, "."]);

      const r = runInternal(
        { ...process.env, HOME: home, GH_TOKEN: dottedToken },
        [
          "worktree", "create",
          "--repo", repo,
          "--branch", branch,
          "--from-branch", "main",
          "--key", key,
        ],
      );

      assert.doesNotMatch(
        r.stderr,
        /SCM token contains unexpected characters/,
        "dot-separated installation tokens must not be rejected",
      );
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The guard is defense-in-depth for the credential-helper string —
  // widening it to allow `.` must not let shell metachars through.
  for (const [label, bad] of [
    ["semicolon", "ghs_abc;rm -rf /"],
    ["command substitution", "ghs_abc`id`"],
    ["dollar", "ghs_abc$FOO"],
    ["whitespace", "ghs_abc def"],
    ["quote", "ghs_abc'\"x"],
    ["newline", "ghs_abc\nx"],
  ] as const) {
    it(`still rejects a token containing a ${label}`, () => {
      const root = mkdtempSync(join(tmpdir(), "opencara-wt-badtok-"));
      try {
        const { home } = seedOrigin(root);
        const r = runInternal(
          { ...process.env, HOME: home, GH_TOKEN: bad },
          [
            "worktree", "create",
            "--repo", "talespark-git/bank-heist",
            "--branch", "opencara/pr-bad",
            "--from-branch", "main",
            "--key", "talespark-git/bank-heist/branch-opencara_pr-bad",
          ],
        );
        assert.notEqual(r.status, 0, "expected a non-zero exit");
        assert.match(r.stderr, /SCM token contains unexpected characters/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

// Azure DevOps repositories live at org/project/_git/repo — three segments,
// which the GitHub-shaped `--repo OWNER/NAME` cannot express. `--clone-url`
// carries the full remote instead, and `--auth-user` the basic-auth username
// (GitHub demands the literal "x-access-token"; Azure DevOps accepts anything).
describe("internal worktree create — platform-neutral clone flags", () => {
  function seedOrigin(root: string): { origin: string; home: string } {
    const home = join(root, "home");
    mkdirSync(join(home, ".opencara", "work"), { recursive: true });
    mkdirSync(join(home, ".opencara", "sessions"), { recursive: true });

    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], {
      stdio: "ignore",
    });

    const seed = join(root, "seed");
    mkdirSync(seed);
    git(seed, ["init", "--initial-branch=main"]);
    git(seed, ["config", "user.email", "t@example.com"]);
    git(seed, ["config", "user.name", "t"]);
    writeFileSync(join(seed, "README"), "hi\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "init"]);
    git(seed, ["remote", "add", "origin", origin]);
    git(seed, ["push", "origin", "main"]);

    return { origin, home };
  }

  const KEY = "contoso/widgets/branch-opencara_pr-1";

  it("accepts OPENCARA_SCM_TOKEN in place of GH_TOKEN", () => {
    const root = mkdtempSync(join(tmpdir(), "opencara-wt-scmtok-"));
    try {
      const { origin, home } = seedOrigin(root);
      const checkout = join(home, ".opencara", "work", KEY, "checkout");
      mkdirSync(checkout, { recursive: true });
      git(checkout, ["clone", origin, "."]);

      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, OPENCARA_SCM_TOKEN: "abc123" };
      delete env.GH_TOKEN;
      const r = runInternal(env, [
        "worktree", "create",
        "--repo", "contoso/widgets",
        "--branch", "opencara/pr-1",
        "--from-branch", "main",
        "--key", KEY,
      ]);

      assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails clearly when neither token variable is set", () => {
    const root = mkdtempSync(join(tmpdir(), "opencara-wt-notok-"));
    try {
      const { home } = seedOrigin(root);
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
      delete env.GH_TOKEN;
      delete env.OPENCARA_SCM_TOKEN;
      const r = runInternal(env, [
        "worktree", "create",
        "--repo", "contoso/widgets",
        "--branch", "opencara/pr-1",
        "--key", KEY,
      ]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /GH_TOKEN or OPENCARA_SCM_TOKEN/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clones from --clone-url, with a --repo that is not OWNER/NAME shaped", () => {
    const root = mkdtempSync(join(tmpdir(), "opencara-wt-cloneurl-"));
    try {
      const { origin, home } = seedOrigin(root);
      // A file:// origin stands in for the real remote; the point under test is
      // that --clone-url is used verbatim and --repo is not shape-validated.
      const r = runInternal(
        { ...process.env, HOME: home, OPENCARA_SCM_TOKEN: "abc123" },
        [
          "worktree", "create",
          "--repo", "contoso/Team",
          "--clone-url", `https://example.invalid/contoso/Team/_git/widgets`,
          "--branch", "opencara/pr-1",
          "--from-branch", "main",
          "--key", KEY,
        ],
      );
      // The clone itself cannot succeed against example.invalid — what matters
      // is that it got as far as attempting the URL we passed, rather than
      // rejecting --repo's shape or falling back to github.com.
      assert.doesNotMatch(r.stderr, /expected OWNER\/NAME/);
      assert.doesNotMatch(r.stderr, /github\.com/);
      void origin;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-https clone url", () => {
    const root = mkdtempSync(join(tmpdir(), "opencara-wt-badurl-"));
    try {
      const { home } = seedOrigin(root);
      const r = runInternal(
        { ...process.env, HOME: home, OPENCARA_SCM_TOKEN: "abc123" },
        [
          "worktree", "create",
          "--clone-url", "ssh://git@example.com/x/y",
          "--branch", "b",
          "--key", KEY,
        ],
      );
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /expected an https:\/\/ URL/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The clone URL lands in a `git clone` argv; a value shaped like a flag would
  // be argument injection.
  it("rejects a clone url that could be read as a git option", () => {
    const root = mkdtempSync(join(tmpdir(), "opencara-wt-injurl-"));
    try {
      const { home } = seedOrigin(root);
      const r = runInternal(
        { ...process.env, HOME: home, OPENCARA_SCM_TOKEN: "abc123" },
        [
          "worktree", "create",
          "--clone-url", "--upload-pack=touch /tmp/pwned",
          "--branch", "b",
          "--key", KEY,
        ],
      );
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /expected an https:\/\/ URL/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an --auth-user containing shell metacharacters", () => {
    const root = mkdtempSync(join(tmpdir(), "opencara-wt-badauthuser-"));
    try {
      const { home } = seedOrigin(root);
      const r = runInternal(
        { ...process.env, HOME: home, OPENCARA_SCM_TOKEN: "abc123" },
        [
          "worktree", "create",
          "--repo", "contoso/widgets",
          "--auth-user", "x`id`",
          "--branch", "b",
          "--key", KEY,
        ],
      );
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /--auth-user contains unexpected characters/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
