import { useCallback, useEffect, useState, useRef } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { IssueBodyEditor } from "@/components/canvas/IssueBodyEditor";
import { AgentPicker } from "@/components/agent/AgentPicker";
import {
  projectIssueDetailQuery,
  useSaveIssueBody,
  useSetIssueDraft,
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

  const save = useSaveIssueBody(projectId, number);
  const setDraft = useSetIssueDraft(projectId, number);

  // The body the user sees. Three sources, in priority order:
  //   1. localDraft — what the user is currently typing in the textarea.
  //      Wins until the debounced PATCH lands and we observe the server
  //      reflecting it. This guards against out-of-order PATCH responses
  //      clobbering newer keystrokes (per-keystroke PATCHes raced badly).
  //   2. issue.draftBodyMd — the unsaved draft on the server (set either
  //      by us via PATCH /draft or by an agent via agent-call).
  //   3. issue.bodyMd — the published GitHub-mirrored body.
  const issue = detailQ.data?.issue;
  const [localDraft, setLocalDraft] = useState<string | null>(null);
  // Tracks the latest text we've sent to the server. Used to decide when
  // localDraft has been confirmed and can be released so external changes
  // (agent-driven drafts) become visible again.
  const lastSentRef = useRef<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const serverBody = issue?.draftBodyMd ?? issue?.bodyMd ?? "";
  const effectiveBody = localDraft ?? serverBody;
  const dirty = !!issue?.draftBodyMd || localDraft !== null;

  // Once the server confirms the latest in-flight value, release the local
  // buffer so subsequent agent-driven draft updates are visible.
  useEffect(() => {
    if (
      localDraft !== null &&
      issue?.draftBodyMd !== undefined &&
      issue.draftBodyMd === lastSentRef.current
    ) {
      setLocalDraft(null);
    }
  }, [issue?.draftBodyMd, localDraft]);

  // Cancel any pending PATCH on unmount so we don't fire after the page is
  // gone (the mutation would still succeed server-side, but it'd surface
  // as an unhandled promise in dev).
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  const onBodyChange = useCallback(
    (next: string) => {
      // Update the visible value synchronously — the user's keystrokes
      // never wait on a network round-trip.
      setLocalDraft(next);
      // Trailing-edge debounce. ~400ms feels indistinguishable from
      // instant for a typing user, while collapsing bursts into one PATCH.
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        lastSentRef.current = next;
        setDraft.mutate(next);
      }, 400);
    },
    [setDraft],
  );

  const onSave = () => {
    if (!dirty) return;
    // If the user has unsent typing in the local buffer, push that exact
    // value as the body to publish — bypassing the server's "use draft"
    // path because the draft hasn't caught up yet. This guarantees the
    // user publishes what they see, not a stale debounce frame.
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (localDraft !== null) {
      save.mutate(localDraft, {
        onSuccess: () => setLocalDraft(null),
      });
      return;
    }
    save.mutate(undefined);
  };

  const onDiscardDraft = () => {
    if (!dirty) return;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setLocalDraft(null);
    lastSentRef.current = null;
    setDraft.mutate(null);
  };

  if (detailQ.isLoading) return <Skeleton className="h-64 w-full" />;
  if (detailQ.error || !issue) {
    return (
      <div className="text-sm text-muted-foreground">
        Issue not found.{" "}
        <Link to={`/projects/${projectId}/issues`} className="underline">
          Back to issues
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <Header
        projectId={projectId}
        issue={issue}
        dirty={dirty}
        saving={save.isPending}
        discarding={setDraft.isPending}
        onSave={onSave}
        onDiscardDraft={onDiscardDraft}
      />
      {save.error && (
        <div className="border-b bg-destructive/10 px-6 py-2 text-xs text-destructive">
          Save failed: {save.error instanceof Error ? save.error.message : String(save.error)}
        </div>
      )}
      <div className="p-6">
        <IssueBodyEditor
          bodyMd={effectiveBody}
          onChange={onBodyChange}
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
  discarding,
  onSave,
  onDiscardDraft,
}: {
  projectId: string;
  issue: {
    number: number;
    title: string;
    state: string;
    htmlUrl: string;
    updatedAt: string;
    labels: { name: string; color: string }[];
    assignees: { login: string; id: number }[];
  };
  dirty: boolean;
  saving: boolean;
  discarding: boolean;
  onSave: () => void;
  onDiscardDraft: () => void;
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
        {dirty && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
            unsaved draft
          </span>
        )}
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
          <AgentPicker
            projectId={projectId}
            issueNumber={issue.number}
            labels={issue.labels}
          />
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <Button
              size="sm"
              variant="ghost"
              disabled={discarding || saving}
              onClick={onDiscardDraft}
            >
              Discard draft
            </Button>
          )}
          <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
            {saving ? "Saving…" : dirty ? "Save to GitHub" : "No changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

