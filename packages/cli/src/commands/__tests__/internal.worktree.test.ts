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
import { execFileSync, spawnSync } from "node:child_process";
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
