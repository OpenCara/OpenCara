import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { IssueBodyEditor } from "@/components/canvas/IssueBodyEditor";
import {
  projectIssueDetailQuery,
  useSaveIssueBody,
} from "@/lib/queries";
import { formatRelative } from "@/lib/format";

export function IssueDetailPage() {
  const { id, number: numberStr } = useParams();
  const number = Number.parseInt(numberStr ?? "", 10);
  const projectId = id!;

  const detailQ = useQuery({
    ...projectIssueDetailQuery(projectId, number),
    enabled: Number.isFinite(number),
  });

  const serverBody = detailQ.data?.issue.bodyMd ?? "";
  const [draftBody, setDraftBody] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [selection, setSelection] = useState<string | null>(null);

  // Initialize draftBody once the server payload arrives.
  const effectiveBody = draftBody ?? serverBody;
  const dirty = draftBody !== null && draftBody !== serverBody;

  const save = useSaveIssueBody(projectId, number);

  const onApplyRewrite = (original: string, replacement: string) => {
    const current = draftBody ?? serverBody;
    if (!current.includes(original)) {
      setWarning(
        "The original snippet is no longer in the body — likely overwritten by a previous Apply. Copy the rewrite manually if you still want it.",
      );
      return;
    }
    setWarning(null);
    setDraftBody(current.replace(original, replacement));
    setSelection(null);
    // Drop browser-native selection so the chip + chat pick up the new state.
    window.getSelection()?.removeAllRanges();
  };

  const onSave = () => {
    if (draftBody === null || draftBody === serverBody) return;
    save.mutate(draftBody, {
      onSuccess: () => {
        // Server returned the refreshed row; the query cache is updated, but
        // we want our local "draft" to be considered clean now.
        setDraftBody(null);
        setWarning(null);
      },
    });
  };

  if (detailQ.isLoading) return <Skeleton className="h-64 w-full" />;
  if (detailQ.error || !detailQ.data) {
    return (
      <div className="text-sm text-muted-foreground">
        Issue not found.{" "}
        <Link to={`/projects/${projectId}/issues`} className="underline">
          Back to issues
        </Link>
      </div>
    );
  }

  const issue = detailQ.data.issue;

  // Two-column layout. The chat panel is rendered embedded (not the floating
  // sidebar variant) so it sits next to the body and stays open by default.
  return (
    <div className="grid h-[calc(100vh-6rem)] grid-cols-[1fr_28rem] gap-0">
      <div className="flex flex-col overflow-hidden">
        <Header
          projectId={projectId}
          issue={issue}
          dirty={dirty}
          saving={save.isPending}
          onSave={onSave}
        />
        {warning && (
          <div className="border-b bg-amber-500/10 px-6 py-2 text-xs text-amber-700 dark:text-amber-300">
            {warning}
          </div>
        )}
        {save.error && (
          <div className="border-b bg-destructive/10 px-6 py-2 text-xs text-destructive">
            Save failed: {save.error instanceof Error ? save.error.message : String(save.error)}
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-6">
          <IssueBodyEditor
            bodyMd={effectiveBody}
            onChange={(next) => setDraftBody(next)}
            onSelectionChange={(sel) => setSelection(sel)}
          />
        </div>
      </div>
      <div className="h-full">
        <ChatPanel
          open={true}
          onClose={() => {
            // unused in embedded variant
          }}
          variant="embedded"
          canvas={useMemo(
            () => ({
              projectId,
              issueNumber: number,
              selection,
              onClearSelection: () => {
                setSelection(null);
                window.getSelection()?.removeAllRanges();
              },
              onApplyRewrite,
            }),
            // eslint-disable-next-line react-hooks/exhaustive-deps
            [projectId, number, selection],
          )}
        />
      </div>
    </div>
  );
}

function Header({
  projectId,
  issue,
  dirty,
  saving,
  onSave,
}: {
  projectId: string;
  issue: { number: number; title: string; state: string; htmlUrl: string; updatedAt: string; labels: { name: string; color: string }[]; assignees: { login: string; id: number }[] };
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <div className="border-b px-6 py-4">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <Link
          to={`/projects/${projectId}/issues`}
          className="flex items-center gap-1 hover:text-foreground"
        >
          <ArrowLeft className="size-3" />
          Back
        </Link>
        <span>·</span>
        <span>updated {formatRelative(issue.updatedAt)}</span>
      </div>
      <div className="mt-2 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-sm text-muted-foreground">#{issue.number}</span>
            <h1 className="truncate text-xl font-semibold">{issue.title}</h1>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant={issue.state === "open" ? "default" : "secondary"}>
              {issue.state}
            </Badge>
            {issue.labels.map((l) => (
              <Badge key={l.name} variant="outline" className="text-xs">
                {l.name}
              </Badge>
            ))}
            {issue.assignees.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {issue.assignees.map((a) => `@${a.login}`).join(", ")}
              </span>
            )}
            <a
              href={issue.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              title="Open on GitHub"
            >
              GitHub <ExternalLink className="size-3" />
            </a>
          </div>
        </div>
        <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
          {saving ? "Saving…" : dirty ? "Save to GitHub" : "No changes"}
        </Button>
      </div>
    </div>
  );
}
