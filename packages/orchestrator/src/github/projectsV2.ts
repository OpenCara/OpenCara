// GitHub Projects v2 GraphQL helpers.
//
// Projects v2 lives entirely in GraphQL (the REST `projects` endpoints serve
// the legacy v1 product). The Octokit returned by GithubAppClient.forInstallation
// already supports `.graphql(query, vars)` with installation-scoped auth, so
// no extra deps are needed here.
//
// Phase 1 implemented read-side helpers (list, snapshot, backfill, single-item
// refresh). Phase 2 adds `setItemStatus` for bidirectional drag.

import { ulid } from "ulid";
import { and, eq } from "drizzle-orm";
import type { Octokit } from "@octokit/rest";
import type { Db } from "../db/client.js";
import { projectV2Items, projectV2Links } from "../db/schema.js";

export interface DiscoveredProjectV2 {
  nodeId: string;
  number: number;
  title: string;
  ownerLogin: string;
  ownerType: "Organization" | "User";
}

export interface StatusOption {
  optionId: string;
  name: string;
  color: string;
  position: number;
}

export interface ProjectV2Snapshot {
  nodeId: string;
  number: number;
  title: string;
  ownerLogin: string;
  ownerType: "Organization" | "User";
  statusFieldNodeId: string;
  statusOptions: StatusOption[];
  items: ProjectV2ItemSnapshot[];
}

export interface ProjectV2ItemSnapshot {
  itemNodeId: string;
  kind: "issue" | "pull_request" | "draft";
  contentNodeId: string | null;
  contentNumber: number | null;
  contentTitle: string;
  contentUrl: string | null;
  contentState: string | null;
  statusOptionId: string | null;
  isArchived: boolean;
  // Card detail caches. Drafts have neither — both stay [].
  assignees: { login: string; id: number }[];
  labels: { name: string; color: string }[];
  updatedAt: string | null;
}

interface RawProjectV2Owner {
  __typename?: string;
  login?: string;
}

interface RawDiscoveredProject {
  id: string;
  number: number;
  title: string;
  owner?: RawProjectV2Owner | null;
}

interface ListProjectsResponse {
  repository: {
    projectsV2: { nodes: RawDiscoveredProject[] | null };
    owner: { __typename: string; login: string };
  } | null;
  organization: {
    projectsV2: { nodes: RawDiscoveredProject[] | null };
  } | null;
  user: {
    projectsV2: { nodes: RawDiscoveredProject[] | null };
  } | null;
}

/**
 * Discover Projects v2 visible to the caller for a given repo. Merges three
 * arms — boards attached to the repo, boards owned by the org (if owner is
 * an Org), and boards owned by the user (if owner is a User) — and dedupes
 * by node id.
 *
 * The `organization` and `user` arms each return NOT_FOUND when the owner
 * isn't of that type; we swallow exactly that failure mode and keep the
 * partial data so a single GraphQL round-trip handles both owner shapes
 * regardless of which one this caller is. Any other GraphQL error
 * (auth, rate limit, schema) propagates.
 *
 * Reach is bounded by the caller's token. With a GitHub App installation
 * token, user-owned Projects v2 are filtered out by GitHub even when
 * repo-attached — kanban callers pass a user OAuth token instead so user
 * boards surface. (See packages/orchestrator/src/routes/api/kanban.ts.)
 */
export async function listAvailableProjects(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<DiscoveredProjectV2[]> {
  const query = /* GraphQL */ `
    query ListProjectsV2($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        projectsV2(first: 50) {
          nodes {
            id
            number
            title
            owner {
              __typename
              ... on Organization { login }
              ... on User { login }
            }
          }
        }
        owner { __typename login }
      }
      organization(login: $owner) {
        projectsV2(first: 50) {
          nodes {
            id
            number
            title
            owner {
              __typename
              ... on Organization { login }
              ... on User { login }
            }
          }
        }
      }
      user(login: $owner) {
        projectsV2(first: 50) {
          nodes {
            id
            number
            title
            owner {
              __typename
              ... on Organization { login }
              ... on User { login }
            }
          }
        }
      }
    }
  `;

  let res: ListProjectsResponse;
  try {
    res = await octokit.graphql<ListProjectsResponse>(query, { owner, repo });
  } catch (err) {
    // The `organization(login:...)` arm 404s when the owner is a User, and
    // the `user(login:...)` arm 404s when the owner is an Org. Octokit
    // surfaces partial data alongside the error. Swallow ONLY that pair of
    // failure modes — any other GraphQL error (auth, rate limit, network,
    // schema mismatch) should propagate so the caller surfaces it.
    const errs = (err as {
      errors?: Array<{ type?: string; path?: Array<string | number> }>;
    }).errors;
    const partial = (err as { data?: ListProjectsResponse }).data;
    const onlyOwnerLookupFailed =
      Array.isArray(errs) &&
      errs.length > 0 &&
      errs.every(
        (e) =>
          e.type === "NOT_FOUND" &&
          Array.isArray(e.path) &&
          (e.path[0] === "organization" || e.path[0] === "user"),
      );
    if (!partial || !onlyOwnerLookupFailed) throw err;
    res = partial;
  }

  const out = new Map<string, DiscoveredProjectV2>();
  const push = (raw: RawDiscoveredProject | null | undefined) => {
    if (!raw) return;
    const ownerType =
      raw.owner?.__typename === "Organization" ? "Organization" : "User";
    out.set(raw.id, {
      nodeId: raw.id,
      number: raw.number,
      title: raw.title,
      ownerLogin: raw.owner?.login ?? owner,
      ownerType,
    });
  };
  for (const n of res.repository?.projectsV2.nodes ?? []) push(n);
  for (const n of res.organization?.projectsV2.nodes ?? []) push(n);
  for (const n of res.user?.projectsV2.nodes ?? []) push(n);
  return Array.from(out.values()).sort((a, b) => a.number - b.number);
}

interface FetchProjectMetadataResponse {
  node: {
    __typename?: string;
    id: string;
    number: number;
    title: string;
    owner?: RawProjectV2Owner | null;
    field?: {
      __typename?: string;
      id: string;
      options?: Array<{ id: string; name: string; color: string }>;
    } | null;
  } | null;
}

interface FetchItemsResponse {
  node: {
    items: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: RawItem[];
    };
  } | null;
}

interface RawAssignees {
  nodes: Array<{ login: string; databaseId: number }> | null;
}
interface RawLabels {
  nodes: Array<{ name: string; color: string }> | null;
}

interface RawItem {
  id: string;
  type: string; // "ISSUE" | "PULL_REQUEST" | "DRAFT_ISSUE" | "REDACTED"
  isArchived: boolean;
  updatedAt: string | null;
  fieldValueByName?: {
    __typename?: string;
    optionId?: string;
  } | null;
  content?:
    | {
        __typename: "Issue";
        id: string;
        number: number;
        title: string;
        url: string;
        state: string;
        assignees?: RawAssignees | null;
        labels?: RawLabels | null;
      }
    | {
        __typename: "PullRequest";
        id: string;
        number: number;
        title: string;
        url: string;
        state: string;
        assignees?: RawAssignees | null;
        labels?: RawLabels | null;
      }
    | {
        __typename: "DraftIssue";
        id: string;
        title: string;
      }
    | null;
}

/**
 * Fetch a Projects v2 board's metadata + all items via GraphQL. Pagination is
 * unbounded (loops until `hasNextPage` is false); a 500-item board fits in a
 * handful of requests and the GraphQL points budget is generous. Caller is
 * responsible for persisting the snapshot.
 */
export async function fetchProjectSnapshot(
  octokit: Octokit,
  projectNodeId: string,
): Promise<ProjectV2Snapshot> {
  const metaQuery = /* GraphQL */ `
    query ProjectV2Meta($id: ID!) {
      node(id: $id) {
        ... on ProjectV2 {
          id
          number
          title
          owner {
            __typename
            ... on Organization { login }
            ... on User { login }
          }
          field(name: "Status") {
            __typename
            ... on ProjectV2SingleSelectField {
              id
              options {
                id
                name
                color
              }
            }
          }
        }
      }
    }
  `;
  const meta = await octokit.graphql<FetchProjectMetadataResponse>(metaQuery, {
    id: projectNodeId,
  });
  const project = meta.node;
  if (!project) {
    throw new Error(`Project v2 not found: ${projectNodeId}`);
  }
  if (!project.field || project.field.__typename !== "ProjectV2SingleSelectField") {
    throw new Error(
      `Project ${project.title} has no Status single-select field; Kanban needs one to render columns.`,
    );
  }

  const statusOptions: StatusOption[] = (project.field.options ?? []).map(
    (o, idx) => ({
      optionId: o.id,
      name: o.name,
      color: o.color,
      position: idx,
    }),
  );

  const itemsQuery = /* GraphQL */ `
    query ProjectV2Items($id: ID!, $after: String) {
      node(id: $id) {
        ... on ProjectV2 {
          items(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              type
              isArchived
              updatedAt
              fieldValueByName(name: "Status") {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  optionId
                }
              }
              content {
                __typename
                ... on Issue {
                  id
                  number
                  title
                  url
                  state
                  assignees(first: 5) { nodes { login databaseId } }
                  labels(first: 10) { nodes { name color } }
                }
                ... on PullRequest {
                  id
                  number
                  title
                  url
                  state
                  assignees(first: 5) { nodes { login databaseId } }
                  labels(first: 10) { nodes { name color } }
                }
                ... on DraftIssue {
                  id
                  title
                }
              }
            }
          }
        }
      }
    }
  `;

  const items: ProjectV2ItemSnapshot[] = [];
  let cursor: string | null = null;
  while (true) {
    const page: FetchItemsResponse = await octokit.graphql<FetchItemsResponse>(
      itemsQuery,
      { id: projectNodeId, after: cursor },
    );
    const conn = page.node?.items;
    if (!conn) break;
    for (const raw of conn.nodes ?? []) {
      items.push(itemSnapshotFromRaw(raw));
    }
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
    cursor = conn.pageInfo.endCursor;
  }

  return {
    nodeId: project.id,
    number: project.number,
    title: project.title,
    ownerLogin: project.owner?.login ?? "",
    ownerType:
      project.owner?.__typename === "User" ? "User" : "Organization",
    statusFieldNodeId: project.field.id,
    statusOptions,
    items,
  };
}

interface FetchSingleItemResponse {
  node: RawItem | null;
}

/**
 * Fetch one item's current state by node id. Used by the webhook handler so
 * edits don't require a full board re-pull. Returns null if the item doesn't
 * exist or isn't a ProjectV2Item.
 */
export async function fetchItemSnapshot(
  octokit: Octokit,
  itemNodeId: string,
): Promise<ProjectV2ItemSnapshot | null> {
  const query = /* GraphQL */ `
    query ProjectV2Item($id: ID!) {
      node(id: $id) {
        ... on ProjectV2Item {
          id
          type
          isArchived
          updatedAt
          fieldValueByName(name: "Status") {
            __typename
            ... on ProjectV2ItemFieldSingleSelectValue {
              optionId
            }
          }
          content {
            __typename
            ... on Issue {
              id number title url state
              assignees(first: 5) { nodes { login databaseId } }
              labels(first: 10) { nodes { name color } }
            }
            ... on PullRequest {
              id number title url state
              assignees(first: 5) { nodes { login databaseId } }
              labels(first: 10) { nodes { name color } }
            }
            ... on DraftIssue { id title }
          }
        }
      }
    }
  `;
  const res = await octokit.graphql<FetchSingleItemResponse>(query, {
    id: itemNodeId,
  });
  if (!res.node) return null;
  return itemSnapshotFromRaw(res.node);
}

/**
 * Upsert a single item snapshot into the mirror. Used by both the webhook
 * handler and the backfill loop so the two paths stay in sync.
 */
export async function upsertItem(
  db: Db,
  linkId: string,
  it: ProjectV2ItemSnapshot,
): Promise<void> {
  await db
    .insert(projectV2Items)
    .values({
      id: ulid(),
      projectV2LinkId: linkId,
      githubItemNodeId: it.itemNodeId,
      kind: it.kind,
      contentNodeId: it.contentNodeId,
      contentNumber: it.contentNumber,
      contentTitle: it.contentTitle,
      contentUrl: it.contentUrl,
      contentState: it.contentState,
      statusOptionId: it.statusOptionId ?? null,
      isArchived: it.isArchived,
      assignees: it.assignees,
      labels: it.labels,
      updatedAt: it.updatedAt ? new Date(it.updatedAt) : new Date(),
    })
    .onConflictDoUpdate({
      target: [projectV2Items.projectV2LinkId, projectV2Items.githubItemNodeId],
      set: {
        kind: it.kind,
        contentNodeId: it.contentNodeId,
        contentNumber: it.contentNumber,
        contentTitle: it.contentTitle,
        contentUrl: it.contentUrl,
        contentState: it.contentState,
        statusOptionId: it.statusOptionId ?? null,
        isArchived: it.isArchived,
        assignees: it.assignees,
        labels: it.labels,
        updatedAt: it.updatedAt ? new Date(it.updatedAt) : new Date(),
      },
    });
}

interface SetItemStatusResponse {
  updateProjectV2ItemFieldValue: {
    projectV2Item: { id: string };
  } | null;
  // For the clearProjectV2ItemFieldValue path:
  clearProjectV2ItemFieldValue?: {
    projectV2Item: { id: string };
  } | null;
}

/**
 * Set or clear the Status (single-select) field on a Projects v2 item.
 *
 * GitHub splits set vs. clear into two distinct mutations:
 *   - updateProjectV2ItemFieldValue with a singleSelectOptionId sets the value
 *   - clearProjectV2ItemFieldValue clears it
 * The "set to null" shape on update is not accepted, so route by `optionId`.
 *
 * Throws on GraphQL error so the route can surface the failure to the UI for
 * optimistic rollback.
 */
export async function setItemStatus(
  octokit: Octokit,
  link: {
    githubProjectNodeId: string;
    statusFieldNodeId: string;
  },
  itemNodeId: string,
  optionId: string | null,
): Promise<void> {
  if (optionId === null) {
    const mutation = /* GraphQL */ `
      mutation ClearStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
        clearProjectV2ItemFieldValue(
          input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }
        ) {
          projectV2Item { id }
        }
      }
    `;
    await octokit.graphql<SetItemStatusResponse>(mutation, {
      projectId: link.githubProjectNodeId,
      itemId: itemNodeId,
      fieldId: link.statusFieldNodeId,
    });
    return;
  }
  const mutation = /* GraphQL */ `
    mutation SetStatus(
      $projectId: ID!
      $itemId: ID!
      $fieldId: ID!
      $optionId: String!
    ) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }
      ) {
        projectV2Item { id }
      }
    }
  `;
  await octokit.graphql<SetItemStatusResponse>(mutation, {
    projectId: link.githubProjectNodeId,
    itemId: itemNodeId,
    fieldId: link.statusFieldNodeId,
    optionId,
  });
}

/** Delete a mirrored item by (link, node id). Idempotent. */
export async function deleteItem(
  db: Db,
  linkId: string,
  itemNodeId: string,
): Promise<void> {
  await db
    .delete(projectV2Items)
    .where(
      and(
        eq(projectV2Items.projectV2LinkId, linkId),
        eq(projectV2Items.githubItemNodeId, itemNodeId),
      ),
    );
}

function itemSnapshotFromRaw(raw: RawItem): ProjectV2ItemSnapshot {
  const c = raw.content;
  let kind: "issue" | "pull_request" | "draft" = "draft";
  if (c?.__typename === "Issue") kind = "issue";
  else if (c?.__typename === "PullRequest") kind = "pull_request";

  const contentNumber =
    c && (c.__typename === "Issue" || c.__typename === "PullRequest")
      ? c.number
      : null;
  const contentUrl =
    c && (c.__typename === "Issue" || c.__typename === "PullRequest") ? c.url : null;
  const contentState =
    c && (c.__typename === "Issue" || c.__typename === "PullRequest") ? c.state : null;

  // Issue + PullRequest carry assignees + labels; DraftIssue does not.
  const hasAssignableContent =
    c?.__typename === "Issue" || c?.__typename === "PullRequest";
  // Note: GitHub GraphQL exposes the user as `databaseId`; we store it under
  // `id` to match the existing `issues.assignees` shape in our DB so the
  // frontend can share render helpers between Issues and Kanban tabs.
  const assignees = hasAssignableContent
    ? (c.assignees?.nodes ?? [])
        .filter(
          (a): a is { login: string; databaseId: number } =>
            typeof a.login === "string" && typeof a.databaseId === "number",
        )
        .map((a) => ({ login: a.login, id: a.databaseId }))
    : [];
  const labels = hasAssignableContent
    ? (c.labels?.nodes ?? [])
        .filter(
          (l): l is { name: string; color: string } =>
            typeof l.name === "string" && typeof l.color === "string",
        )
        .map((l) => ({ name: l.name, color: l.color }))
    : [];

  return {
    itemNodeId: raw.id,
    kind,
    contentNodeId: c?.id ?? null,
    contentNumber,
    contentTitle: c?.title ?? "(untitled)",
    contentUrl,
    contentState,
    statusOptionId: raw.fieldValueByName?.optionId ?? null,
    isArchived: raw.isArchived,
    assignees,
    labels,
    updatedAt: raw.updatedAt,
  };
}

/**
 * Replace the local mirror for a link with a fresh snapshot from GitHub.
 *
 * Race model: a webhook can fire mid-backfill and insert a brand-new row
 * for an item that wasn't on the board when our GraphQL paginate started.
 * To avoid deleting that row in the cleanup pass, we **freeze the set of
 * existing item ids before the GraphQL fetch**. Cleanup only deletes rows
 * from that frozen set — anything inserted after the freeze is left alone
 * even if it didn't appear in `seen`. Conversely, an item that existed
 * before the fetch but didn't appear in the snapshot was either deleted on
 * GitHub or filtered out (e.g. archived + we drop archived) — safe to
 * remove.
 */
export async function backfillBoard(
  db: Db,
  link: { id: string; githubProjectNodeId: string },
  octokit: Octokit,
): Promise<{ snapshot: ProjectV2Snapshot; itemCount: number }> {
  // Freeze the pre-fetch set of mirrored items.
  const before = await db
    .select({ githubItemNodeId: projectV2Items.githubItemNodeId })
    .from(projectV2Items)
    .where(eq(projectV2Items.projectV2LinkId, link.id));
  const beforeIds = new Set(before.map((r) => r.githubItemNodeId));

  const snapshot = await fetchProjectSnapshot(octokit, link.githubProjectNodeId);

  await db
    .update(projectV2Links)
    .set({
      githubProjectNumber: snapshot.number,
      githubProjectTitle: snapshot.title,
      githubProjectOwner: snapshot.ownerLogin,
      githubProjectOwnerType: snapshot.ownerType,
      statusFieldNodeId: snapshot.statusFieldNodeId,
      statusOptions: snapshot.statusOptions,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(projectV2Links.id, link.id));

  const seen = new Set<string>();
  for (const it of snapshot.items) {
    seen.add(it.itemNodeId);
    await upsertItem(db, link.id, it);
  }

  // Delete only rows that existed at the freeze point AND weren't in the
  // new snapshot. Webhook-inserted rows that arrived after the freeze are
  // not candidates for deletion.
  for (const id of beforeIds) {
    if (!seen.has(id)) {
      await deleteItem(db, link.id, id);
    }
  }

  return { snapshot, itemCount: snapshot.items.length };
}
