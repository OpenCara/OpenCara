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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
