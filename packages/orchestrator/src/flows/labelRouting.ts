/**
 * Pure helpers for the single-valued, prefix-scoped issue/PR labels that route
 * the implement flow's agent + prompt (`agent:<name>`, `prompt:<name>`).
 *
 * Kept free of DB / engine imports so the parsing rules can be unit-tested in
 * isolation; the DB lookups + fail-loud policy live in nodeRunners.ts.
 */

/**
 * Extract the `<value>` portion of every `<prefix><value>` label in `names`.
 *
 * Values are trimmed and empties dropped (a bare `agent:` label carries no
 * routing intent). Order is preserved and duplicates are NOT collapsed — the
 * caller decides what "more than one distinct value" means (the routers treat
 * 2+ as an ambiguity error).
 */
export function extractScopedLabelValues(
  names: readonly string[],
  prefix: string,
): string[] {
  return names
    .filter((n) => n.startsWith(prefix))
    .map((n) => n.slice(prefix.length).trim())
    .filter((n) => n.length > 0);
}
