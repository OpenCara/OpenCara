import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { ExternalLink, Plus } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  installationsQuery,
  availableReposQuery,
  useAddProject,
  authProvidersQuery,
  azureConnectionsQuery,
  azureOrganizationsQuery,
  useConnectAzurePat,
  azureRepositoriesQuery,
  useConnectAzureOrg,
  useAddAzureProject,
  type InstallationSummary,
  type AvailableRepo,
} from "@/lib/queries";
import { ApiError } from "@/lib/api";

const APP_INSTALL_URL = "https://github.com/apps/opencara/installations/new";

type Source = "github" | "azure";

export function AddProjectPage() {
  const [source, setSource] = useState<Source>("github");
  // Only offer a platform this deployment actually configured. Its API routes
  // don't mount otherwise, so an unconditional tab sends the user straight into
  // a 404 from a route that never existed.
  const providers = useQuery(authProvidersQuery());

  const available: [Source, string][] = [];
  // Default both to true while the probe is in flight so the GitHub tab (the
  // overwhelmingly common case) renders immediately rather than flashing in.
  if (providers.data?.providers.github ?? true) available.push(["github", "GitHub"]);
  if (providers.data?.providers.entra ?? false) available.push(["azure", "Azure DevOps"]);

  // Fall back to whatever is available if the current selection isn't offered
  // (e.g. the probe resolves after mount and Azure DevOps isn't configured).
  const activeSource: Source =
    available.some(([value]) => value === source) ? source : (available[0]?.[0] ?? "github");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Add project</h1>
        <p className="text-sm text-muted-foreground">
          Pick a repository from a connected account.
        </p>
      </div>

      {/* A one-option switcher is just noise — show it only when there's a choice. */}
      {available.length > 1 && (
        <div className="inline-flex rounded-md border p-1">
          {available.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setSource(value)}
              className={`rounded px-3 py-1.5 text-sm transition ${
                activeSource === value
                  ? "bg-secondary font-medium"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {activeSource === "github" ? <GithubSource /> : <AzureSource />}
    </div>
  );
}

function GithubSource() {
  const installations = useQuery(installationsQuery());
  const [selected, setSelected] = useState<InstallationSummary | null>(null);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        {installations.isLoading ? (
          <Skeleton className="h-32" />
        ) : (
          (installations.data?.installations ?? []).map((inst) => (
            <Card
              key={inst.id}
              className={`cursor-pointer transition ${
                selected?.id === inst.id ? "ring-2 ring-ring" : ""
              }`}
              onClick={() => setSelected(inst)}
            >
              <CardHeader>
                <CardTitle className="text-base">{inst.accountLogin}</CardTitle>
                <CardDescription>{inst.accountType}</CardDescription>
              </CardHeader>
              {inst.suspendedAt && (
                <CardContent>
                  <Badge variant="destructive">suspended</Badge>
                </CardContent>
              )}
            </Card>
          ))
        )}
        <a
          href={APP_INSTALL_URL}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground hover:bg-secondary/40"
        >
          <ExternalLink className="mr-2 size-4" />
          Install on another account
        </a>
      </div>

      {selected && <RepoPicker installation={selected} />}
    </div>
  );
}

/**
 * Azure DevOps source. Two steps, because connecting an organization and
 * picking a repo from it need different credentials: the org list comes from
 * the signed-in user's Entra token, the repo list from the stored connection.
 */
function AzureSource() {
  const orgs = useQuery(azureOrganizationsQuery());
  const connections = useQuery(azureConnectionsQuery());
  const connect = useConnectAzureOrg();
  const [connectionId, setConnectionId] = useState<string | null>(null);

  const existing = connections.data?.connections ?? [];
  // Microsoft sign-in is unavailable, or this session has no Microsoft
  // credentials. Either way a PAT is the way in — and for an organization
  // backed by a personal Microsoft account it is the ONLY way in, since Azure
  // DevOps is registered in Entra as work/school-only.
  const entraUnavailable =
    orgs.isError &&
    orgs.error instanceof ApiError &&
    (orgs.error.status === 409 || orgs.error.status === 404);

  if (orgs.isLoading || connections.isLoading) return <Skeleton className="h-32" />;

  // 409 = this session authenticated with GitHub, so it holds no Microsoft
  // credentials. Recoverable by signing in with Microsoft, so say that rather
  // than showing a generic error.
  if (orgs.isError && !entraUnavailable) {
    const needsSignIn =
      orgs.error instanceof ApiError && orgs.error.status === 409;
    // 404 = the Azure DevOps routes were never mounted, i.e. AZDO_ENTRA_* is
    // unset on this deployment. Unreachable now that the tab is gated on the
    // providers probe, but "API 404" told the user nothing, so name the cause.
    const notConfigured =
      orgs.error instanceof ApiError && orgs.error.status === 404;
    return (
      <Card>
        <CardContent className="space-y-3 py-8 text-center">
          {notConfigured ? (
            <div className="text-sm text-muted-foreground">
              Azure DevOps isn't configured on this deployment. Set{" "}
              <code>AZDO_ENTRA_CLIENT_ID</code> and{" "}
              <code>AZDO_ENTRA_CLIENT_SECRET</code> on the orchestrator and restart
              it — see the Azure DevOps section of the README.
            </div>
          ) : needsSignIn ? (
            <>
              <div className="text-sm text-muted-foreground">
                Connecting an Azure DevOps organization needs Microsoft credentials on
                this session.
              </div>
              <Button
                onClick={() => {
                  window.location.href = "/auth/azure/login";
                }}
              >
                Sign in with Microsoft
              </Button>
            </>
          ) : (
            <div className="text-sm text-destructive">
              Failed to load organizations:{" "}
              {orgs.error instanceof Error ? orgs.error.message : "unknown error"}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  const organizations = orgs.data?.organizations ?? [];

  return (
    <div className="space-y-6">
      {existing.length > 0 && (
        <div className="grid gap-4 md:grid-cols-3">
          {existing.map((conn) => (
            <Card
              key={conn.id}
              className={`cursor-pointer transition ${
                connectionId === conn.id ? "ring-2 ring-ring" : ""
              }`}
              onClick={() => setConnectionId(conn.id)}
            >
              <CardHeader>
                <CardTitle className="text-base">{conn.orgName}</CardTitle>
                <CardDescription>
                  connected via {conn.authMode === "pat" ? "access token" : "Microsoft"}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      <AzurePatConnect onConnected={setConnectionId} />

      {entraUnavailable && existing.length === 0 && (
        <div className="text-xs text-muted-foreground">
          Microsoft sign-in isn't available for this session. An organization backed by a
          personal Microsoft account can only be connected with an access token — Azure
          DevOps does not issue Microsoft sign-in tokens to personal accounts.
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        {organizations.map((org) => (
          <Card
            key={org.id}
            className={`cursor-pointer transition ${
              connectionId && org.connectionId === connectionId ? "ring-2 ring-ring" : ""
            }`}
            onClick={() => {
              if (org.connectionId) {
                setConnectionId(org.connectionId);
                return;
              }
              connect.mutate(org.name, {
                onSuccess: (res) => setConnectionId(res.connection.id),
              });
            }}
          >
            <CardHeader>
              <CardTitle className="text-base">{org.name}</CardTitle>
              <CardDescription>
                {org.connectionId ? "connected" : "click to connect"}
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>

      {connect.isError && (
        <div className="text-sm text-destructive">
          Could not connect:{" "}
          {connect.error instanceof Error ? connect.error.message : "unknown error"}
        </div>
      )}

      {connectionId && <AzureRepoPicker connectionId={connectionId} />}
    </div>
  );
}

/**
 * Connect an Azure DevOps organization with a Personal Access Token.
 *
 * Required for organizations backed by a personal Microsoft account, which
 * Azure DevOps will not issue Microsoft sign-in tokens for. The token is
 * verified against the organization server-side before it is stored, so a bad
 * or wrongly-scoped token is reported here rather than failing later.
 */
function AzurePatConnect({ onConnected }: { onConnected: (id: string) => void }) {
  const [orgName, setOrgName] = useState("");
  const [pat, setPat] = useState("");
  const connect = useConnectAzurePat();

  const submit = () => {
    if (!orgName.trim() || !pat.trim()) return;
    connect.mutate(
      { orgName: orgName.trim(), pat: pat.trim() },
      {
        onSuccess: (res) => {
          setPat("");
          onConnected(res.connection.id);
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">
          Connect with an access token
        </CardTitle>
        <CardDescription>
          From Azure DevOps: User settings → Personal access tokens. Needs{" "}
          <span className="font-medium">Code (read &amp; write)</span>,{" "}
          <span className="font-medium">Work items (read &amp; write)</span> and{" "}
          <span className="font-medium">Service hooks (read &amp; write)</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="azdo-org">Organization</Label>
            <Input
              id="azdo-org"
              placeholder="e.g. ShiningPie"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The segment after dev.azure.com/
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="azdo-pat">Personal access token</Label>
            <Input
              id="azdo-pat"
              type="password"
              autoComplete="off"
              placeholder="••••••••"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            <p className="text-xs text-muted-foreground">
              Stored encrypted; never shown again after saving.
            </p>
          </div>
        </div>
        <Button disabled={connect.isPending || !orgName.trim() || !pat.trim()} onClick={submit}>
          {connect.isPending ? "Verifying…" : "Connect"}
        </Button>
        {connect.isError && (
          <div className="text-sm text-destructive">
            {connect.error instanceof ApiError &&
            typeof (connect.error.body as { error?: string })?.error === "string"
              ? (connect.error.body as { error: string }).error
              : "Could not connect."}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AzureRepoPicker({ connectionId }: { connectionId: string }) {
  const repos = useQuery(azureRepositoriesQuery(connectionId));
  const add = useAddAzureProject();
  const navigate = useNavigate();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Available repositories</CardTitle>
        <CardDescription>
          Adding a repository also subscribes to its Azure DevOps service hooks.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {repos.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : repos.isError ? (
          <div className="py-8 text-center text-sm text-destructive">
            Failed to load repositories:{" "}
            {repos.error instanceof Error ? repos.error.message : "unknown error"}
          </div>
        ) : (repos.data?.repositories ?? []).length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No Git repositories in this organization.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project / repo</TableHead>
                <TableHead>Default branch</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(repos.data?.repositories ?? []).map((repo) => (
                <TableRow key={repo.id}>
                  <TableCell className="font-medium">
                    <span className="text-muted-foreground">{repo.projectName}</span> /{" "}
                    {repo.name}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {repo.defaultBranch ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {repo.added ? (
                      <Badge variant="secondary">added</Badge>
                    ) : (
                      <Button
                        size="sm"
                        disabled={add.isPending}
                        onClick={() =>
                          add.mutate(
                            { connectionId, repositoryId: repo.id },
                            { onSuccess: (res) => navigate(`/projects/${res.project.id}`) },
                          )
                        }
                      >
                        <Plus className="size-4" />
                        Add
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {add.isError && (
          <div className="pt-3 text-sm text-destructive">
            Could not add:{" "}
            {add.error instanceof Error ? add.error.message : "unknown error"}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RepoPicker({ installation }: { installation: InstallationSummary }) {
  const repos = useQuery(availableReposQuery(installation.id));
  const add = useAddProject();
  const navigate = useNavigate();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">
          Available repos in {installation.accountLogin}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {repos.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : repos.isError ? (
          isInstallationGone(repos.error) ? (
            <InstallationGoneNotice />
          ) : (
            <div className="py-8 text-center text-sm text-destructive">
              Failed to load repos: {formatReposError(repos.error)}
            </div>
          )
        ) : !repos.data || repos.data.available.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No repos available — they may all be added already, or this installation has no
            repos selected.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Repo</TableHead>
                <TableHead>Default branch</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {repos.data.available.map((repo) => (
                <RepoRow
                  key={repo.id}
                  installationId={installation.id}
                  repo={repo}
                  busy={add.isPending}
                  onAdd={(p) => navigate(`/projects/${p.id}`)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function isInstallationGone(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    typeof err.body === "object" &&
    err.body !== null &&
    (err.body as { code?: unknown }).code === "installation_gone"
  );
}

function InstallationGoneNotice() {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
      <div className="font-medium">GitHub App installation no longer exists</div>
      <p className="mt-1 text-muted-foreground">
        The OpenCara GitHub App installation behind this row is gone — usually
        because it was uninstalled, or its account was renamed/deleted.
        Reinstall the App on the same account, then reload this page.
      </p>
      <a
        href={APP_INSTALL_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-flex items-center gap-1 text-foreground underline underline-offset-2 hover:no-underline"
      >
        Reinstall the OpenCara App <ExternalLink className="size-3.5" />
      </a>
    </div>
  );
}

// The orchestrator's API surface returns shapes like {error: "..."} and
// {error: {message: "..."}} depending on the route — flatten to a single
// human string for the error banner.
function formatReposError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body;
    if (body && typeof body === "object" && "error" in body) {
      const v = (body as { error: unknown }).error;
      if (typeof v === "string") return v;
      if (v && typeof v === "object" && "message" in v) {
        return String((v as { message: unknown }).message);
      }
    }
    return `API ${err.status}`;
  }
  return err instanceof Error ? err.message : "unknown error";
}

function RepoRow({
  installationId,
  repo,
  busy,
  onAdd,
}: {
  installationId: string;
  repo: AvailableRepo;
  busy: boolean;
  onAdd: (p: { id: string }) => void;
}) {
  const add = useAddProject();
  return (
    <TableRow>
      <TableCell>
        <span className="font-medium">{repo.fullName}</span>
        {repo.private && (
          <Badge variant="secondary" className="ml-2">
            private
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">{repo.defaultBranch}</TableCell>
      <TableCell className="text-right">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || add.isPending}
          onClick={() =>
            add.mutate(
              { installationId, githubRepoId: repo.id },
              { onSuccess: (res) => onAdd(res.project) },
            )
          }
        >
          <Plus className="size-4" />
          Add
        </Button>
      </TableCell>
    </TableRow>
  );
}
