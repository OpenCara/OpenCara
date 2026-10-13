// Project instructions file (issue #130): the orchestrator sends a validated
// repo-relative path (default AGENTS.md); the device reads it from the job's
// worktree and appends it to the agent's instructions. Every miss logs one
// stderr line and skips the file — silence is the worse failure mode.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import type { LogSink } from "./markers.js";

/** Files larger than this almost certainly carry generated content nobody
 *  meant to inject as instructions — skip rather than truncate. */
const INSTRUCTIONS_FILE_MAX_BYTES = 64 * 1024;

export interface ResolvedInstructionsFile {
  /** Real path, inside cwd. */
  path: string;
  content: string;
}

/**
 * Resolve `relative` against `cwd`, require it to stay inside cwd, and read
 * it (bounded). Null on any miss.
 *
 * Containment is checked on REAL paths: a repo could commit `AGENTS.md` as
 * a symlink to `~/.ssh/id_rsa` — the lexical check passes (the link lives
 * in cwd), and the target's content would reach the model and leak through
 * its output (PR comments, commit messages, chat).
 */
export function resolveInstructionsFile(
  cwd: string,
  relative: string | undefined,
  onLog: LogSink,
): ResolvedInstructionsFile | null {
  if (!relative) return null;
  const skip = (why: string): null => {
    onLog("stderr", `[opencara] instructions file skipped: ${why}\n`);
    return null;
  };
  if (!isAbsolute(cwd)) return skip(`cwd '${cwd}' is not absolute`);
  if (isAbsolute(relative) || /^[A-Za-z]:[\\/]/.test(relative)) {
    return skip(`'${relative}' must be repo-relative`);
  }
  if (relative.split(/[\\/]/).includes("..")) return skip(`'${relative}' contains '..'`);
  const base = normalize(cwd);
  const candidate = resolve(base, relative);
  if (!within(candidate, base)) return skip(`'${candidate}' escapes cwd`);

  let realBase: string;
  let realCandidate: string;
  try {
    realBase = realpathSync(base);
  } catch (err) {
    return skip(`cwd '${base}' realpath failed: ${errorText(err)}`);
  }
  try {
    realCandidate = realpathSync(candidate);
  } catch (err) {
    return skip(`'${relative}' not found in cwd (${errorText(err)})`);
  }
  if (!within(realCandidate, realBase)) {
    return skip(`'${relative}' resolves to '${realCandidate}', outside cwd (symlink escape?)`);
  }
  let size: number;
  try {
    const stat = statSync(realCandidate);
    if (!stat.isFile()) return skip(`'${relative}' is not a regular file`);
    size = stat.size;
  } catch (err) {
    return skip(`'${relative}' stat failed: ${errorText(err)}`);
  }
  if (size > INSTRUCTIONS_FILE_MAX_BYTES) {
    return skip(`'${relative}' is ${size} bytes (> ${INSTRUCTIONS_FILE_MAX_BYTES} cap)`);
  }
  try {
    return { path: realCandidate, content: readFileSync(realCandidate, "utf8") };
  } catch (err) {
    return skip(`read failed for '${relative}': ${errorText(err)}`);
  }
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
