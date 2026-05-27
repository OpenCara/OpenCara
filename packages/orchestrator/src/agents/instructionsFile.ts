// Project-level agent instructions file: orchestrator-side validation.
//
// Why this module exists: every agent CLI (claude, codex, opencode, pi)
// ships its own auto-discovery convention for a project-level instructions
// file — `~/.claude/CLAUDE.md` + `<cwd>/CLAUDE.md` for claude,
// `~/.codex/AGENTS.md` + `<cwd>/AGENTS.md` for codex, etc. The content
// the agent "knows" thus silently varies by kind on the same flow run,
// and one operator's interactive convention in `~/.claude/CLAUDE.md`
// (e.g. "do NOT auto-commit or push") can override a flow contract that
// explicitly requires commit + push. Real-world failure on
// flow run 01KSM02PAQZXG7H94P3DNTARKD (issue #130).
//
// Fix per #130: strip each adapter's per-kind auto-discovery and inject
// ONE canonical file (configurable per project) as the system prompt.
//
// Division of labor:
//
// - This module (runs on the orchestrator) validates the project's
//   `instructions_file` SETTING — a repo-relative path string — and
//   returns the validated relative path or an operator-visible skip
//   reason. It does NOT touch the filesystem: the worktree lives on the
//   device, not on this host.
//
// - The claude-acp adapter (runs on the device, where the worktree
//   actually exists) takes the relative path + cwd from session/new and
//   resolves + stat-checks before forwarding to `claude`. A missing file
//   on the device is a quiet skip there, not a flow failure.

export interface ValidateInstructionsFileSettingOpts {
  /**
   * Repo-relative path from `projects.instructions_file`. Defaults to
   * `AGENTS.md`. Empty / whitespace = "disabled for this project" →
   * returns `{ skipReason }` without rejecting the setting.
   */
  setting: string | null | undefined;
}

export interface ValidateInstructionsFileSettingResult {
  /** Validated repo-relative path to forward into AcpSpec.instructionsFile. */
  relativePath?: string;
  /**
   * Operator-visible reason when no path was forwarded. The engine surfaces
   * this so a flow run that ran without the project file still leaves a
   * breadcrumb in the step's input record. Empty when validation passes.
   */
  skipReason?: string;
}

/**
 * Validate a project's `instructions_file` setting. The setting names a
 * file relative to the repo root in the agent's worktree; the actual
 * existence check happens on the device side (see claude-acp). Validation
 * rules — kept strict because the value flows straight into an agent CLI
 * as a system-prompt source:
 *
 * - Setting must be a non-empty string after trimming. Empty / whitespace
 *   disables injection for the project — returns `{ skipReason }`, not an
 *   error.
 * - Setting must NOT be absolute. Project settings name a path inside the
 *   repo, never an arbitrary host path.
 * - Setting must NOT contain a `..` segment. Defense-in-depth against a
 *   misconfigured project pointing the agent at `../../../etc/passwd`.
 * - Setting must end in `.md` (case-insensitive). The API enforces the
 *   same rule on write (validateInstructionsFileInput) but we re-check
 *   here so direct DB writes / migration backfills / future seed scripts
 *   can't sneak `secret.env` past the dispatch path. The strict authority
 *   lives next to the read site, not at the write boundary.
 */
export function validateInstructionsFileSetting(
  opts: ValidateInstructionsFileSettingOpts,
): ValidateInstructionsFileSettingResult {
  const raw = typeof opts.setting === "string" ? opts.setting.trim() : "";
  if (raw.length === 0) {
    return { skipReason: "project instructionsFile setting is empty" };
  }
  // POSIX abs path (`/foo`) and Windows-drive abs path (`C:\foo`).
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    return {
      skipReason: `project instructionsFile '${raw}' must be repo-relative, not absolute`,
    };
  }
  const segments = raw.split(/[\\/]/);
  if (segments.some((s) => s === "..")) {
    return {
      skipReason: `project instructionsFile '${raw}' contains a '..' segment`,
    };
  }
  if (!/\.md$/i.test(raw)) {
    return {
      skipReason: `project instructionsFile '${raw}' must end in .md`,
    };
  }
  return { relativePath: raw };
}
