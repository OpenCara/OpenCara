import type { GithubAppClient } from "../github/app.js";
import { createGithubProvider } from "./github/provider.js";
import type { PlatformId, ScmProvider } from "./types.js";

/**
 * The minimum a caller must know about a project to get a provider for it.
 * Structural rather than the drizzle row type so tests can pass a literal and
 * so this doesn't couple the seam to the exact schema shape while the Azure
 * DevOps columns are still landing.
 */
export interface ProviderTarget {
  platform: PlatformId;
  owner: string;
  name: string;
}

export interface ProviderDeps {
  app: GithubAppClient;
  /** The GitHub App installation id backing this project. */
  githubInstallationId: number;
}

/**
 * Resolve the provider for a project. This is the ONLY place in the
 * orchestrator that is allowed to switch on `platform` — everything downstream
 * takes an `ScmProvider` and stays platform-blind.
 *
 * Constructing a provider mints/reuses an installation client, so call it once
 * per step rather than per action.
 */
export async function providerFor(
  target: ProviderTarget,
  deps: ProviderDeps,
): Promise<ScmProvider> {
  switch (target.platform) {
    case "github": {
      const octokit = await deps.app.forInstallation(deps.githubInstallationId);
      return createGithubProvider({ octokit, owner: target.owner, repo: target.name });
    }
    case "azure_devops":
      // Lands in the Azure DevOps PR-flow phase, together with the connection
      // row that carries the Entra credentials this needs.
      throw new Error(
        "azure_devops provider is not implemented yet — project is on a platform this build cannot act on",
      );
  }
}
