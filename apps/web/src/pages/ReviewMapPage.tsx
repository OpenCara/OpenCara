import { useCallback, useMemo, useState } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { ReactFlowInstance } from "@xyflow/react";
import { ReactFlowProvider } from "@xyflow/react";
import {
  FILE_NODE_HEIGHT,
  FILE_NODE_WIDTH,
  type ReviewMapGraph,
} from "@opencara/shared";
import { api, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ReviewMapCanvas } from "@/components/reviewMap/ReviewMapCanvas";
import { FileDetailPanel } from "@/components/reviewMap/FileDetailPanel";

const VERDICT_BADGE: Record<string, { label: string; className: string }> = {
  APPROVE: { label: "Approved", className: "bg-emerald-600 text-white" },
  REQUEST_CHANGES: {
    label: "Changes requested",
    className: "bg-red-600 text-white",
  },
  COMMENT: { label: "Commented", className: "bg-muted text-muted-foreground" },
};

export function ReviewMapPage() {
  const { id } = useParams<{ id: string }>();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [onlyFindings, setOnlyFindings] = useState(false);
  const [rf, setRf] = useState<ReactFlowInstance | null>(null);

  const query = useQuery({
    queryKey: ["review-map", id],
    queryFn: () => api.get<ReviewMapGraph>(`/api/review-maps/${id}`),
    // The graph is immutable once stored — a stale map never needs refetch.
    staleTime: Infinity,
  });

  const graph = query.data;
  const fileByPath = useMemo(
    () => new Map((graph?.files ?? []).map((f) => [f.path, f])),
    [graph],
  );
  const selected = selectedPath ? fileByPath.get(selectedPath) : undefined;

  const centerOn = useCallback(
    (path: string) => {
      const f = fileByPath.get(path);
      if (!f || !rf) return;
      setSelectedPath(path);
      rf.setCenter(
        f.position.x + FILE_NODE_WIDTH / 2,
        f.position.y + FILE_NODE_HEIGHT / 2,
        { zoom: 1.2, duration: 300 },
      );
    },
    [fileByPath, rf],
  );

  const submitSearch = () => {
    const q = search.trim().toLowerCase();
    if (!q || !graph) return;
    const first = graph.files.find((f) => f.path.toLowerCase().includes(q));
    if (first) centerOn(first.path);
  };

  if (query.isPending) {
    return (
      <div className="flex min-h-screen flex-col">
        <div className="border-b p-4">
          <Skeleton className="h-6 w-64" />
        </div>
        <div className="flex-1 p-6">
          <Skeleton className="h-full w-full" />
        </div>
      </div>
    );
  }

  if (query.isError || !graph) {
    const notFound =
      query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="mb-2 text-lg font-semibold">
            {notFound
              ? "This review map doesn't exist or has expired"
              : "Couldn't load the review map"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {notFound
              ? "The link may be malformed, or the map may have been removed."
              : "Try reloading the page."}
          </p>
        </div>
      </div>
    );
  }

  const verdict = graph.verdict ? VERDICT_BADGE[graph.verdict] : undefined;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2">
        <span className="text-xs font-semibold tracking-wide text-muted-foreground">
          OpenCara
        </span>
        <span className="text-sm font-semibold">{graph.repo}</span>
        {graph.pr.url ? (
          <a
            href={graph.pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline"
          >
            PR #{graph.pr.number}
          </a>
        ) : (
          <span className="text-sm">PR #{graph.pr.number}</span>
        )}
        {verdict && (
          <Badge className={verdict.className}>{verdict.label}</Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {graph.totals.files} files ·{" "}
          <span className="text-emerald-600">+{graph.totals.additions}</span>{" "}
          <span className="text-red-600">−{graph.totals.deletions}</span> ·{" "}
          {graph.totals.findings} findings
          {graph.reviewer ? ` · ${graph.reviewer}` : ""}
          {graph.truncated ? ` · listing truncated at ${graph.truncated.listedFiles}` : ""}
        </span>
        {graph.reviewUrl && (
          <a
            href={graph.reviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-xs text-primary hover:underline"
          >
            View review ↗
          </a>
        )}
      </header>

      <div className="flex items-center gap-3 border-b px-4 py-2">
        <form
          className="w-64"
          onSubmit={(e) => {
            e.preventDefault();
            submitSearch();
          }}
        >
          <Input
            placeholder="Search files…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8"
          />
        </form>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={onlyFindings}
            onChange={(e) => setOnlyFindings(e.target.checked)}
          />
          Only files with findings
        </label>
        <div className="ml-auto hidden items-center gap-3 text-[10px] text-muted-foreground md:flex">
          <LegendSwatch className="bg-emerald-600" label="added" />
          <LegendSwatch className="bg-blue-600" label="modified" />
          <LegendSwatch className="bg-red-600" label="removed" />
          <LegendSwatch className="bg-violet-600" label="renamed" />
          <span className="text-muted-foreground/50">|</span>
          <LegendSwatch className="bg-red-600" label="high" />
          <LegendSwatch className="bg-orange-600" label="medium" />
          <LegendSwatch className="bg-yellow-500" label="low" />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="min-h-0 flex-1">
          <ReactFlowProvider>
            <ReviewMapCanvas
              graph={graph}
              selectedPath={selectedPath}
              hoveredPath={hoveredPath}
              search={search}
              onlyFindings={onlyFindings}
              onSelect={setSelectedPath}
              onHover={setHoveredPath}
              onInit={setRf}
            />
          </ReactFlowProvider>
        </div>
        {selected && (
          <div className="max-h-[50vh] lg:max-h-none">
            <FileDetailPanel
              graph={graph}
              file={selected}
              onSelect={centerOn}
              onClose={() => setSelectedPath(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${className}`} />
      {label}
    </span>
  );
}
