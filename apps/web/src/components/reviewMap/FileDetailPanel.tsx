import type {
  ReviewMapFile,
  ReviewMapGraph,
  ReviewMapSeverity,
} from "@opencara/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<ReviewMapFile["status"], string> = {
  added: "Added",
  modified: "Modified",
  removed: "Removed",
  renamed: "Renamed",
};

const SEVERITY_CLASS: Record<ReviewMapSeverity, string> = {
  high: "bg-red-600 text-white",
  medium: "bg-orange-600 text-white",
  low: "bg-yellow-500 text-black",
  info: "bg-muted text-muted-foreground",
};

export interface FileDetailPanelProps {
  graph: ReviewMapGraph;
  file: ReviewMapFile;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function FileDetailPanel({
  graph,
  file,
  onSelect,
  onClose,
}: FileDetailPanelProps) {
  const fileByPath = new Map(graph.files.map((f) => [f.path, f]));
  const dependsOn = graph.edges
    .filter((e) => e.source === file.path)
    .map((e) => e.target);
  const usedBy = graph.edges
    .filter((e) => e.target === file.path)
    .map((e) => e.source);

  const depList = (title: string, paths: string[]) =>
    paths.length > 0 && (
      <div>
        <h4 className="mb-1 text-xs font-semibold text-muted-foreground">
          {title}
        </h4>
        <ul className="space-y-0.5">
          {paths.map((p) => (
            <li key={p}>
              <button
                type="button"
                className="w-full truncate rounded px-1.5 py-0.5 text-left text-xs text-primary hover:bg-accent"
                title={p}
                onClick={() => onSelect(p)}
              >
                {fileByPath.has(p) ? p : `${p} (not shown)`}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <div className="flex h-full w-full flex-col border-l bg-card lg:w-80">
      <div className="flex items-start justify-between gap-2 border-b p-3">
        <div className="min-w-0">
          <div className="break-all text-sm font-semibold">{file.path}</div>
          {file.previousPath && (
            <div className="text-xs text-muted-foreground">
              renamed from {file.previousPath}
            </div>
          )}
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{STATUS_LABEL[file.status]}</Badge>
            <span>
              <span className="text-emerald-600">+{file.additions}</span>{" "}
              <span className="text-red-600">−{file.deletions}</span>
            </span>
            {file.language && <span>{file.language}</span>}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          ✕
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {file.findings.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold text-muted-foreground">
                Findings ({file.findings.length})
              </h4>
              <ul className="space-y-2">
                {file.findings.map((f, i) => (
                  <li key={i} className="rounded border p-2 text-xs">
                    <div className="mb-1 flex items-center gap-2">
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                          SEVERITY_CLASS[f.severity],
                        )}
                      >
                        {f.severity}
                      </span>
                      {f.line !== undefined && (
                        <span className="text-muted-foreground">
                          line {f.line}
                          {f.endLine !== undefined && f.endLine !== f.line
                            ? `–${f.endLine}`
                            : ""}
                        </span>
                      )}
                    </div>
                    <p className="text-foreground/90">{f.text}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {depList("Depends on", dependsOn)}
          {depList("Used by", usedBy)}
          {file.diffUrl && (
            <a
              href={file.diffUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-xs text-primary hover:underline"
            >
              View diff ↗
            </a>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
