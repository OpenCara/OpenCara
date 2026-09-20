/**
 * ACP agents can stream their working narration through the same text
 * channel as the final answer — devin emits "Let me check X…" message
 * chunks all the way up to its verdict, codex-acp does the same, and agy
 * interleaves narration inside its reply. A PR review must never publish
 * narration before the contract verdict, so when a standalone verdict
 * line exists the body starts there; agy gets an additional boundary at
 * its final `## Summary` for the structured-review format, and agy
 * output with no verdict at all is refused outright since its body is
 * almost certainly pure narration.
 */
export function reviewBodyForPublication(
  body: string,
  agentName: string | undefined,
): string | null {
  const isAgy = agentName?.trim().toLowerCase().startsWith("agy") ?? false;
  const normalized = body.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let verdictLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^verdict\s*:\s*(approve|request_changes|comment)\s*$/i.test(lines[i]!.trim())) {
      verdictLine = i;
      break;
    }
  }
  if (verdictLine < 0) return isAgy ? null : body;

  const verdict = lines[verdictLine]!.trim();
  const afterVerdict = lines.slice(verdictLine + 1).join("\n").trim();
  if (isAgy) {
    const summaries = [...afterVerdict.matchAll(/^## Summary\s*$/gim)];
    for (let i = summaries.length - 1; i >= 0; i--) {
      const start = summaries[i]!.index!;
      const candidate = afterVerdict.slice(start).trim();
      if (/^## Findings\s*$/im.test(candidate)) return `${verdict}\n\n${candidate}`;
    }
    return afterVerdict ? `${verdict}\n\n${afterVerdict}` : null;
  }
  // A verdict as the LAST line means the body came first — a contract
  // violation, but the content is real; keep it rather than refuse. Any
  // non-empty tail means the pre-verdict text was narration: drop it.
  return afterVerdict ? `${verdict}\n\n${afterVerdict}` : body;
}
