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
