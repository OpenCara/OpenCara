/**
 * agy can stream its working narration through the same text channel as its
 * final answer. A PR review must never publish narration before the contract
 * verdict. Structured initial reviews get an additional boundary at their
 * final Summary; follow-up reviews use a different, valid body format.
 */
export function reviewBodyForPublication(
  body: string,
  agentName: string | undefined,
): string | null {
  if (!agentName?.trim().toLowerCase().startsWith("agy")) return body;

  const normalized = body.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let verdictLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^verdict\s*:\s*(approve|request_changes|comment)\s*$/i.test(lines[i]!.trim())) {
      verdictLine = i;
      break;
    }
  }
  if (verdictLine < 0) return null;

  const verdict = lines[verdictLine]!.trim();
  const afterVerdict = lines.slice(verdictLine + 1).join("\n").trim();
  const summaries = [...afterVerdict.matchAll(/^## Summary\s*$/gim)];
  for (let i = summaries.length - 1; i >= 0; i--) {
    const start = summaries[i]!.index!;
    const candidate = afterVerdict.slice(start).trim();
    if (/^## Findings\s*$/im.test(candidate)) return `${verdict}\n\n${candidate}`;
  }
  return afterVerdict ? `${verdict}\n\n${afterVerdict}` : null;
}
