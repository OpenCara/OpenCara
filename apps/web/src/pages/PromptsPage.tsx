import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { Pencil, Trash2, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  promptsQuery,
  useCreatePrompt,
  useDeletePrompt,
  useUpdatePrompt,
  type PromptRow,
} from "@/lib/queries";
import { ApiError } from "@/lib/api";
import { formatRelative } from "@/lib/format";

export function PromptsPage() {
  const { id } = useParams();
  const projectId = id!;
  const q = useQuery(promptsQuery(projectId));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Prompts</h1>
        <p className="text-sm text-muted-foreground">
          Reusable prompt bodies for this project. Link a prompt to a flow's
          agent node from the flow detail page.
        </p>
      </div>

      <NewPromptCard projectId={projectId} />

      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : !q.data || q.data.prompts.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No prompts yet. Create one above.
        </div>
      ) : (
        <div className="space-y-4">
          {q.data.prompts.map((p) => (
            <PromptCard key={p.id} projectId={projectId} prompt={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function NewPromptCard({ projectId }: { projectId: string }) {
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const create = useCreatePrompt(projectId);
  const error = create.error instanceof ApiError ? create.error.body : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium text-muted-foreground">
          New prompt
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label htmlFor="new-prompt-name">Name</Label>
          <Input
            id="new-prompt-name"
            placeholder="e.g. Strict reviewer"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="new-prompt-body">Body</Label>
          <Textarea
            id="new-prompt-body"
            placeholder="You are a code reviewer. Focus on..."
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-32 font-mono text-xs"
          />
        </div>
        {error !== null && error !== undefined && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {extractErrorMessage(error)}
          </div>
        )}
        <div className="flex justify-end">
          <Button
            disabled={!name.trim() || !body.trim() || create.isPending}
            onClick={() =>
              create.mutate(
                { name: name.trim(), body: body.trim() },
                {
                  onSuccess: () => {
                    setName("");
                    setBody("");
                  },
                },
              )
            }
          >
            {create.isPending ? "Saving…" : "Save prompt"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "error" in err) {
    const v = (err as { error: unknown }).error;
    return typeof v === "string" ? v : JSON.stringify(v);
  }
  return "Save failed";
}

function PromptCard({ projectId, prompt }: { projectId: string; prompt: PromptRow }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(prompt.name);
  const [body, setBody] = useState(prompt.body);
  const update = useUpdatePrompt(projectId);
  const remove = useDeletePrompt(projectId);
  const dirty = name !== prompt.name || body !== prompt.body;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {editing ? (
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            ) : (
              <CardTitle className="text-base">{prompt.name}</CardTitle>
            )}
            <div className="mt-1 text-xs text-muted-foreground">
              Updated {formatRelative(prompt.updatedAt)}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {editing ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing(false);
                    setName(prompt.name);
                    setBody(prompt.body);
                  }}
                >
                  <X className="size-4" />
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={!dirty || update.isPending}
                  onClick={() =>
                    update.mutate(
                      { id: prompt.id, name: name.trim(), body },
                      { onSuccess: () => setEditing(false) },
                    )
                  }
                >
                  {update.isPending ? "Saving…" : "Save"}
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  <Pencil className="size-4" />
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm(`Delete prompt "${prompt.name}"?`)) {
                      remove.mutate(prompt.id);
                    }
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {editing ? (
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-40 font-mono text-xs"
          />
        ) : (
          <pre className="whitespace-pre-wrap rounded-md bg-muted/30 p-3 font-mono text-xs leading-relaxed">
            {prompt.body}
          </pre>
        )}
        {!editing && (
          <div className="mt-2">
            <Badge variant="secondary" className="text-xs">
              {prompt.body.split(/\s+/).filter(Boolean).length} words
            </Badge>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
