/**
 * Turns the compact `subject_json` slice the activity query extracts from a
 * platform-event payload into a labelled, linkable subject for the Activity
 * feed. Pure so it stays unit-testable without a database.
 *
 * The SQL side pulls out only the identifying fields (number/id + title) so
 * the feed never ships whole webhook payloads for agent runs; this side owns
 * the platform-specific URL shapes.
 */

export interface ActivityProject {
  id: string;
  owner: string;
  name: string;
  platform: "github" | "azure_devops";
  webUrl: string | null;
}

export interface ActivitySubject {
  kind: "pull_request" | "issue" | "work_item" | "push";
  /** PR / issue number, work item id, or null for pushes. */
  number: number | null;
  title: string | null;
  /** Browser URL on the hosting platform, when derivable. */
  url: string | null;
  /** Short human label, e.g. "PR #12", "Issue #7", "WI #301", "push main". */
  label: string;
}

/** Raw shape produced by `subjectJsonExpr` in activity.ts. */
export interface RawSubject {
  kind?: string | null;
  number?: number | string | null;
  title?: unknown;
  /** Set on `issue`-keyed payloads when the issue is actually a PR
   *  (issue_comment on a pull request). */
  isPr?: boolean | null;
  /** Platform browser URL carried by the payload itself (Azure PR events). */
  url?: string | null;
  /** push only */
  ref?: string | null;
  compare?: string | null;
}

export function repoWebUrl(project: ActivityProject): string | null {
  if (project.webUrl) return project.webUrl.replace(/\/+$/, "");
  if (project.platform === "github") return `https://github.com/${project.owner}/${project.name}`;
  return null;
}

export function buildSubject(
  raw: RawSubject | null | undefined,
  project: ActivityProject | null,
): ActivitySubject | null {
  if (!raw || !raw.kind) return null;
  const base = project ? repoWebUrl(project) : null;
  const platform = project?.platform ?? "github";
  const number = toNumber(raw.number);
  const title = toTitle(raw.title);

  switch (raw.kind) {
    case "pull_request":
    case "issue": {
      const isPr = raw.kind === "pull_request" || raw.isPr === true;
      if (number == null) return null;
      if (isPr) {
        const url =
          (typeof raw.url === "string" && /^https?:\/\//.test(raw.url) ? raw.url : null) ??
          (base
            ? platform === "azure_devops"
              ? `${base}/pullrequest/${number}`
              : `${base}/pull/${number}`
            : null);
        return { kind: "pull_request", number, title, url, label: `PR #${number}` };
      }
      const url = base && platform === "github" ? `${base}/issues/${number}` : null;
      return { kind: "issue", number, title, url, label: `Issue #${number}` };
    }
    case "work_item": {
      if (number == null) return null;
      // Azure DevOps: webUrl is {org}/{project}/_git/{repo}; work items live
      // one level up under {org}/{project}/_workitems/edit/{id}.
      const projectRoot = base?.split("/_git/")[0] ?? null;
      const url = projectRoot ? `${projectRoot}/_workitems/edit/${number}` : null;
      return { kind: "work_item", number, title, url, label: `WI #${number}` };
    }
    case "push": {
      const ref = typeof raw.ref === "string" ? raw.ref.replace(/^refs\/heads\//, "") : null;
      const url = typeof raw.compare === "string" && raw.compare ? raw.compare : null;
      return { kind: "push", number: null, title: null, url, label: ref ? `push ${ref}` : "push" };
    }
    default:
      return null;
  }
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

/**
 * Azure `workitem.updated` deliveries carry `fields` as a map of
 * `{ oldValue, newValue }`; creates carry plain values. Accept both.
 */
function toTitle(v: unknown): string | null {
  if (typeof v === "string") return v || null;
  if (v && typeof v === "object" && "newValue" in v) {
    const nv = (v as { newValue?: unknown }).newValue;
    return typeof nv === "string" && nv ? nv : null;
  }
  return null;
}
