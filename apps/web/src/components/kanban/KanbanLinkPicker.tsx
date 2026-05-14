import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import {
  kanbanProjectsQuery,
  useLinkKanban,
  type DiscoveredProjectV2,
} from "@/lib/queries";

const APP_INSTALL_URL = "https://github.com/apps/opencara/installations/new";

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
        The OpenCara GitHub App installation that owns this project is gone —
        usually because it was uninstalled, or its account was renamed/deleted.
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

export function KanbanLinkPicker({ projectId }: { projectId: string }) {
  const q = useQuery(kanbanProjectsQuery(projectId));
  const link = useLinkKanban(projectId);
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Link a GitHub Projects v2 board</CardTitle>
        <CardDescription>
          Mirror an existing Projects v2 board into a Kanban view here.
          Webhooks keep the mirror in sync; cards link back to GitHub.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : q.error ? (
          isInstallationGone(q.error) ? (
            <InstallationGoneNotice />
          ) : (
            <div className="text-sm text-destructive">
              Failed to load projects:{" "}
              {q.error instanceof Error ? q.error.message : String(q.error)}
            </div>
          )
        ) : !q.data || q.data.projects.length === 0 ? (
          <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
            No Projects v2 boards visible to this installation. Create one on
            GitHub (or attach an existing board to this repo), then refresh.
            Org-level boards require the App to be installed at the org level
            with <span className="font-mono">Projects: Read &amp; Write</span>.
          </div>
        ) : (
          <div className="space-y-2">
            {q.data.projects.map((p) => (
              <ProjectRow
                key={p.nodeId}
                project={p}
                selected={selected === p.nodeId}
                onSelect={() => setSelected(p.nodeId)}
              />
            ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          {link.error &&
            (isInstallationGone(link.error) ? (
              <div className="text-xs text-destructive">
                GitHub App installation is gone — reinstall and reload.
              </div>
            ) : (
              <div className="text-xs text-destructive">
                {link.error instanceof Error
                  ? link.error.message
                  : String(link.error)}
              </div>
            ))}
          <div className="ml-auto">
            <Button
              size="sm"
              disabled={!selected || link.isPending}
              onClick={() => selected && link.mutate(selected)}
            >
              {link.isPending ? "Linking…" : "Link board"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ProjectRow({
  project,
  selected,
  onSelect,
}: {
  project: DiscoveredProjectV2;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center justify-between rounded-md border p-3 text-left transition-colors ${
        selected ? "border-primary bg-accent/30" : "hover:bg-accent/20"
      }`}
    >
      <div>
        <div className="text-sm font-medium">{project.title}</div>
        <div className="text-xs text-muted-foreground">
          @{project.ownerLogin} · #{project.number}
        </div>
      </div>
      <a
        href={`https://github.com/${
          project.ownerType === "Organization" ? "orgs" : "users"
        }/${project.ownerLogin}/projects/${project.number}`}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="text-muted-foreground hover:text-foreground"
        title="Open on GitHub"
      >
        <ExternalLink className="size-3.5" />
      </a>
    </button>
  );
}
