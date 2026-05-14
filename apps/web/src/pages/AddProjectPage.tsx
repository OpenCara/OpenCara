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
  type InstallationSummary,
  type AvailableRepo,
} from "@/lib/queries";
import { ApiError } from "@/lib/api";

const APP_INSTALL_URL = "https://github.com/apps/opencara/installations/new";

export function AddProjectPage() {
  const installations = useQuery(installationsQuery());
  const [selected, setSelected] = useState<InstallationSummary | null>(null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Add project</h1>
        <p className="text-sm text-muted-foreground">
          Pick a repository from one of your installations.
        </p>
      </div>

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
