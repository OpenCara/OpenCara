/**
 * Agents can stream their working narration through the same text channel
 * as the final answer ("Let me check X…" chunks all the way up to the
 * verdict). A PR review must never publish narration before the contract
 * verdict, so when a standalone verdict line exists the body starts there.
 * The synthesizer's structured-review skeleton (a final `## Summary`
 * followed by `## Findings`) is a second boundary — it rescues replies that
 * skip the verdict line entirely.
 */
export function reviewBodyForPublication(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let verdictLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^verdict\s*:\s*(approve|request_changes|comment)\s*$/i.test(lines[i]!.trim())) {
      verdictLine = i;
      break;
    }
  }
  if (verdictLine < 0) {
    const anchored = lastStructuredSection(normalized);
    if (anchored) return anchored;
    return body;
  }

  const verdict = lines[verdictLine]!.trim();
  const afterVerdict = lines.slice(verdictLine + 1).join("\n").trim();
  const anchored = lastStructuredSection(afterVerdict);
  if (anchored) return `${verdict}\n\n${anchored}`;
  // A verdict as the LAST line means the body came first — a contract
  // violation, but the content is real; keep it rather than refuse.
  // Any non-empty tail means the pre-verdict text was narration: drop it.
  if (!afterVerdict) return body;
  return `${verdict}\n\n${afterVerdict}`;
}

/** The tail starting at the last `## Summary` heading that is followed by a `## Findings` heading. */
function lastStructuredSection(text: string): string | null {
  const summaries = [...text.matchAll(/^## Summary\s*$/gim)];
  for (let i = summaries.length - 1; i >= 0; i--) {
    const candidate = text.slice(summaries[i]!.index!).trim();
    if (/^## Findings\s*$/im.test(candidate)) return candidate;
  }
  return null;
}
