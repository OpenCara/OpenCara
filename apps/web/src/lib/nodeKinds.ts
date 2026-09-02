/**
 * Flow node kinds were renamed `github.*` → `scm.*` when Azure DevOps support
 * landed, so one flow graph can run against either platform (the orchestrator
 * resolves the concrete provider from the project at run time).
 *
 * The API normalizes graphs on read, so anything arriving as part of a
 * `graphJson` is already canonical. What is NOT normalized is a *persisted*
 * kind string echoed back from a historical row — `flow_run_steps.node_kind` on
 * a run that predates the rename. Route those through `normalizeNodeKind`
 * before matching, or old runs fall through to a generic status label.
 *
 * Mirrors LEGACY_NODE_KIND_ALIASES in packages/flows/src/types.ts. Kept as a
 * local copy rather than a dependency because the web app deliberately does not
 * pull in @opencara/flows (it would drag zod into the client bundle for six
 * string constants).
 */
const LEGACY_NODE_KIND_ALIASES: Readonly<Record<string, string>> = {
  "github.pull_request": "scm.pull_request",
  "github.pull_request_review": "scm.pull_request_review",
  "github.projects_v2_item": "scm.board_item",
  "github.post_review": "scm.post_review",
  "github.add_comment": "scm.add_comment",
  "github.add_label": "scm.add_label",
};

/** Unknown and already-canonical kinds pass through untouched. */
export function normalizeNodeKind(kind: string): string {
  return LEGACY_NODE_KIND_ALIASES[kind] ?? kind;
}
