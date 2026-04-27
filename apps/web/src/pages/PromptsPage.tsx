import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router";
import { Pencil, Search, Tag, Trash2, X } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { useRegisterChatAction } from "@/lib/chatActions";

export function PromptsPage() {
  const q = useQuery(promptsQuery());
  const location = useLocation();
  const [search, setSearch] = useState("");
  const [activeLabel, setActiveLabel] = useState<string | null>(null);

  const all = q.data?.prompts ?? [];

  // Sidebar's prompt list links here as /prompts#prompt-<id>; scroll +
  // flash. Mirrors AgentsPage; cleanup strips the ring on switch.
  useEffect(() => {
    if (!all.length) return;
    const hash = location.hash;
    if (!hash.startsWith("#prompt-")) return;
    const el = document.getElementById(hash.slice(1));
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("ring-2", "ring-primary/60");
    const t = setTimeout(() => {
      el.classList.remove("ring-2", "ring-primary/60");
    }, 1500);
    return () => {
      clearTimeout(t);
      el.classList.remove("ring-2", "ring-primary/60");
    };
  }, [location.hash, all]);

  // Aggregate label set for the filter chip cloud — sorted by frequency.
  const labelCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of all) {
      for (const lbl of p.labels) m.set(lbl, (m.get(lbl) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [all]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return all.filter((p) => {
      if (activeLabel && !p.labels.includes(activeLabel)) return false;
      if (!needle) return true;
      if (p.name.toLowerCase().includes(needle)) return true;
      if (p.body.toLowerCase().includes(needle)) return true;
      if (p.labels.some((l) => l.toLowerCase().includes(needle))) return true;
      return false;
    });
  }, [all, search, activeLabel]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Prompts</h1>
        <p className="text-sm text-muted-foreground">
          Reusable prompt bodies. Link a prompt to any flow's agent node from
          the flow detail page; library is shared across all your projects.
        </p>
      </div>

      <NewPromptCard />

      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, body, or label…"
            className="pl-8"
          />
        </div>
        {labelCounts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {activeLabel && (
              <button
                type="button"
                onClick={() => setActiveLabel(null)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                clear filter ✕
              </button>
            )}
            {labelCounts.map(([lbl, n]) => (
              <button
                key={lbl}
                type="button"
                onClick={() => setActiveLabel(activeLabel === lbl ? null : lbl)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs",
                  activeLabel === lbl
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-muted/30 text-muted-foreground hover:border-foreground/40 hover:text-foreground",
                )}
              >
                <Tag className="mr-1 inline-block size-2.5" />
                {lbl}
                <span className="ml-1 opacity-60">{n}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : all.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No prompts yet. Create one above.
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No prompts match the current search/filter.
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((p) => (
            <PromptCard key={p.id} prompt={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function NewPromptCard() {
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [labelsText, setLabelsText] = useState("");
  const create = useCreatePrompt();
  const error = create.error instanceof ApiError ? create.error.body : null;

  // Chat panel can drop suggestions straight into the body.
  useRegisterChatAction("prompt", (text) => setBody(text.trim()));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium text-muted-foreground">
          New prompt
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
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
            <Label htmlFor="new-prompt-labels">Labels (comma-separated)</Label>
            <Input
              id="new-prompt-labels"
              placeholder="reviewer, security, strict"
              value={labelsText}
              onChange={(e) => setLabelsText(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="new-prompt-body">Body</Label>
          <Textarea
            id="new-prompt-body"
            placeholder="System / user prompt body…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-32 font-mono text-xs"
          />
        </div>
        {error !== null && error !== undefined && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {extractErr(error)}
          </div>
        )}
        <div className="flex justify-end">
          <Button
            disabled={!name.trim() || !body.trim() || create.isPending}
            onClick={() =>
              create.mutate(
                {
                  name: name.trim(),
                  body: body.trim(),
                  labels: parseLabels(labelsText),
                },
                {
                  onSuccess: () => {
                    setName("");
                    setBody("");
                    setLabelsText("");
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

function PromptCard({ prompt }: { prompt: PromptRow }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(prompt.name);
  const [body, setBody] = useState(prompt.body);
  const [labelsText, setLabelsText] = useState(prompt.labels.join(", "));
  const update = useUpdatePrompt();
  const remove = useDeletePrompt();

  const reset = () => {
    setName(prompt.name);
    setBody(prompt.body);
    setLabelsText(prompt.labels.join(", "));
  };

  return (
    <Card id={`prompt-${prompt.id}`} className="scroll-mt-4 transition-shadow">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {editing ? (
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            ) : (
              <CardTitle className="text-base">{prompt.name}</CardTitle>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>Updated {formatRelative(prompt.updatedAt)}</span>
              {prompt.labels.map((lbl) => (
                <Badge key={lbl} variant="outline" className="font-normal">
                  <Tag className="mr-1 inline-block size-2.5" />
                  {lbl}
                </Badge>
              ))}
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
                    reset();
                  }}
                >
                  <X className="size-4" />
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate(
                      {
                        id: prompt.id,
                        name: name.trim(),
                        body,
                        labels: parseLabels(labelsText),
                      },
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
      <CardContent className="space-y-3">
        {editing ? (
          <>
            <div>
              <Label>Labels (comma-separated)</Label>
              <Input
                value={labelsText}
                onChange={(e) => setLabelsText(e.target.value)}
              />
            </div>
            <div>
              <Label>Body</Label>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="min-h-40 font-mono text-xs"
              />
            </div>
          </>
        ) : (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-muted/30 p-3 font-mono text-xs leading-relaxed">
            {prompt.body}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

function parseLabels(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractErr(err: unknown): string {
  if (err && typeof err === "object" && "error" in err) {
    const v = (err as { error: unknown }).error;
    return typeof v === "string" ? v : JSON.stringify(v);
  }
  return "Save failed";
}
