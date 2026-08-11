import type { GithubAppClient } from "../github/app.js";
import type { AzureDevopsClientDeps } from "../azure/client.js";
import { clientForConnection } from "../azure/client.js";
import { parseAzureOwnerLabel } from "../azure/repos.js";
import { createGithubProvider } from "./github/provider.js";
import { createAzureProvider } from "./azure/provider.js";
import type { PlatformId, ScmProvider } from "./types.js";

/**
 * The minimum a caller must know about a project to get a provider for it.
 * Structural rather than the drizzle row type so tests can pass a literal.
 */
export interface ProviderTarget {
  platform: PlatformId;
  /** GitHub: repo owner. Azure DevOps: "org/project" (see azureOwnerLabel). */
  owner: string;
  name: string;
  /** Azure DevOps repository GUID. Required when platform is azure_devops. */
  externalRepoId?: string | null;
  /** Azure DevOps connection row id. Required when platform is azure_devops. */
  azdoConnectionId?: string | null;
}

export interface ProviderDeps {
  /** Required for GitHub projects. */
  app?: GithubAppClient;
  /** The GitHub App installation id backing this project. */
  githubInstallationId?: number;
  /** Required for Azure DevOps projects. */
  azure?: AzureDevopsClientDeps;
}

/**
 * Resolve the provider for a project. This is the ONLY place in the
 * orchestrator that switches on `platform` — everything downstream takes an
 * `ScmProvider` and stays platform-blind.
 *
 * Constructing a provider may mint or refresh a token, so call it once per step
 * rather than per action.
 */
export async function providerFor(
  target: ProviderTarget,
  deps: ProviderDeps,
): Promise<ScmProvider> {
  switch (target.platform) {
    case "github": {
      if (!deps.app || deps.githubInstallationId === undefined) {
        throw new Error("github provider needs an app client and installation id");
      }
      const octokit = await deps.app.forInstallation(deps.githubInstallationId);
      return createGithubProvider({ octokit, owner: target.owner, repo: target.name });
    }
    case "azure_devops": {
      if (!deps.azure) {
        throw new Error(
          "azure devops provider needs db/cipher/entra deps — is AZDO_ENTRA_* configured?",
        );
      }
      if (!target.azdoConnectionId || !target.externalRepoId) {
        throw new Error(
          "azure devops provider needs the project's connection id and repository id",
        );
      }
      const client = await clientForConnection(deps.azure, target.azdoConnectionId);
      if (!client) {
        throw new Error(
          `azure devops connection ${target.azdoConnectionId} no longer exists — reconnect the organization`,
        );
      }
      // `owner` is "org/project"; the API path needs the team project alone.
      const parsed = parseAzureOwnerLabel(target.owner);
      if (!parsed) {
        throw new Error(
          `azure devops project owner '${target.owner}' is not in the expected "org/project" form`,
        );
      }
      return createAzureProvider({
        client,
        projectName: parsed.projectName,
        repositoryId: target.externalRepoId,
      });
    }
  }
}
