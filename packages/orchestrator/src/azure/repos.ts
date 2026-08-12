import { z } from "zod";
import type { AzureDevopsClient } from "./client.js";

/**
 * Organization / project / repository discovery.
 *
 * Note the two different hosts. Repos and work items live under
 * `dev.azure.com/{org}`, but the "which organizations can this user see?"
 * lookup lives on the older `app.vssps.visualstudio.com` profile service and
 * takes a *profile id*, not the Entra object id — hence the two-step in
 * `listOrganizations`.
 */

const VSSPS_BASE = "https://app.vssps.visualstudio.com";

export interface AzureDevopsOrg {
  id: string;
  name: string;
  url: string;
}

const ProfileSchema = z.object({ id: z.string() });

const AccountsSchema = z.object({
  value: z.array(
    z.object({
      accountId: z.string(),
      accountName: z.string(),
      accountUri: z.string().optional(),
    }),
  ),
});

/**
 * Organizations the signed-in user belongs to.
 *
 * Takes a raw access token rather than an AzureDevopsClient because it runs
 * *before* any organization is connected — during the connect flow there is no
 * connection row to build a client from.
 */
export async function listOrganizations(accessToken: string): Promise<AzureDevopsOrg[]> {
  const profile = await vsspsGet(
    accessToken,
    `${VSSPS_BASE}/_apis/profile/profiles/me?api-version=7.1`,
  );
  const parsedProfile = ProfileSchema.safeParse(profile);
  if (!parsedProfile.success) {
    throw new Error("azure devops profile lookup returned no id");
  }
  const accounts = await vsspsGet(
    accessToken,
    `${VSSPS_BASE}/_apis/accounts?memberId=${encodeURIComponent(parsedProfile.data.id)}&api-version=7.1`,
  );
  const parsedAccounts = AccountsSchema.safeParse(accounts);
  if (!parsedAccounts.success) return [];
  return parsedAccounts.data.value.map((a) => ({
    id: a.accountId,
    name: a.accountName,
    url: `https://dev.azure.com/${a.accountName}`,
  }));
}

async function vsspsGet(accessToken: string, url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`azure devops profile API failed (${res.status}): ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      "azure devops profile API returned a non-JSON body — the token is probably missing the Azure DevOps scope",
    );
  }
}

export interface AzureDevopsRepo {
  /** Repository GUID — the value stored as `projects.external_repo_id`. */
  id: string;
  name: string;
  /** Team project the repo belongs to. */
  projectName: string;
  projectId: string;
  defaultBranch: string | null;
  webUrl: string;
  /** Azure DevOps team projects are private unless explicitly made public. */
  isPrivate: boolean;
}

const RepoListSchema = z.object({
  value: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      // `defaultBranch` is absent on a repository with no commits yet.
      defaultBranch: z.string().optional(),
      webUrl: z.string().optional(),
      remoteUrl: z.string().optional(),
      project: z.object({
        id: z.string(),
        name: z.string(),
        visibility: z.string().optional(),
      }),
    }),
  ),
});

/**
 * Every Git repository in the organization the user can see.
 *
 * The org-wide form (no project segment) is one call instead of one per team
 * project, which matters for orgs with dozens of projects.
 */
export async function listRepositories(
  client: AzureDevopsClient,
): Promise<AzureDevopsRepo[]> {
  const raw = await client.orgRequest("_apis/git/repositories");
  const parsed = RepoListSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("azure devops repository list had an unexpected shape");
  }
  return parsed.data.value.map((r) => ({
    id: r.id,
    name: r.name,
    projectName: r.project.name,
    projectId: r.project.id,
    // Azure DevOps returns a full ref ("refs/heads/main"); everything
    // downstream (worktree checkout, PR base) wants the short name.
    defaultBranch: r.defaultBranch ? r.defaultBranch.replace(/^refs\/heads\//, "") : null,
    webUrl:
      r.webUrl ??
      `${client.orgUrl}/${encodeURIComponent(r.project.name)}/_git/${encodeURIComponent(r.name)}`,
    isPrivate: r.project.visibility !== "public",
  }));
}

/**
 * Display owner for an Azure DevOps repo: "org/project".
 *
 * Azure DevOps identifies a repo by three segments (org / project / repo) where
 * GitHub uses two. Folding the first two into `projects.owner` keeps
 * (owner, name) a unique, human-readable handle on both platforms without a
 * platform-specific column — and `external_repo_id` remains the real identity.
 */
export function azureOwnerLabel(orgName: string, projectName: string): string {
  return `${orgName}/${projectName}`;
}

/** Inverse of `azureOwnerLabel`. Returns null if the label isn't well-formed. */
export function parseAzureOwnerLabel(
  owner: string,
): { orgName: string; projectName: string } | null {
  const idx = owner.indexOf("/");
  if (idx <= 0 || idx === owner.length - 1) return null;
  return { orgName: owner.slice(0, idx), projectName: owner.slice(idx + 1) };
}

/**
 * HTTPS clone URL. Azure DevOps accepts HTTP Basic with any username and the
 * token as the password, so the credential helper on the device supplies the
 * username separately (see the CLI's worktree create).
 */
export function azureCloneUrl(orgName: string, projectName: string, repoName: string): string {
  return `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(
    projectName,
  )}/_git/${encodeURIComponent(repoName)}`;
}
