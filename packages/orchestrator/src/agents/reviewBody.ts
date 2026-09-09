/**
 * agy can stream its working narration through the same text channel as its
 * final answer. A PR review must never publish that narration. Its review
 * prompt requires a structured final response, so retain only that section.
 */
export function reviewBodyForPublication(
  body: string,
  agentName: string | undefined,
): string | null {
  if (!agentName?.trim().toLowerCase().startsWith("agy")) return body;

  const summaries = [...body.matchAll(/^## Summary\s*$/gim)];
  for (let i = summaries.length - 1; i >= 0; i--) {
    const start = summaries[i]!.index!;
    const candidate = body.slice(start).trim();
    if (/^## Findings\s*$/im.test(candidate)) return candidate;
  }
  return null;
}
