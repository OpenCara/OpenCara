import { useMemo } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  edgeSides,
  FILE_NODE_HEIGHT,
  FILE_NODE_WIDTH,
  type ReviewMapGraph,
} from "@opencara/shared";
import { FileNode, type ReviewMapFileNode } from "./FileNode";

interface GroupBoxData extends Record<string, unknown> {
  label: string;
}

type GroupBoxNode = Node<GroupBoxData, "groupBox">;

/** Non-interactive directory container painted beneath the file nodes. */
function GroupBox({ data }: NodeProps<GroupBoxNode>) {
  return (
    <div className="h-full w-full rounded-lg border bg-muted/30">
      <span className="absolute left-2.5 top-1.5 text-[11px] font-semibold text-muted-foreground">
        {data.label}
      </span>
    </div>
  );
}

const nodeTypes = { file: FileNode, groupBox: GroupBox };

const MINIMAP_STATUS_COLOR: Record<string, string> = {
  added: "#059669",
  modified: "#2563eb",
  removed: "#dc2626",
  renamed: "#7c3aed",
};

export interface ReviewMapCanvasProps {
  graph: ReviewMapGraph;
  selectedPath: string | null;
  hoveredPath: string | null;
  search: string;
  onlyFindings: boolean;
  onSelect: (path: string | null) => void;
  onHover: (path: string | null) => void;
  onInit: (instance: ReactFlowInstance) => void;
}

export function ReviewMapCanvas({
  graph,
  selectedPath,
  hoveredPath,
  search,
  onlyFindings,
  onSelect,
  onHover,
  onInit,
}: ReviewMapCanvasProps) {
  const focusPath = hoveredPath ?? selectedPath;

  const neighbors = useMemo(() => {
    if (!focusPath) return null;
    const set = new Set<string>([focusPath]);
    for (const e of graph.edges) {
      if (e.source === focusPath) set.add(e.target);
      if (e.target === focusPath) set.add(e.source);
    }
    return set;
  }, [graph.edges, focusPath]);

  const matched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return new Set(
      graph.files
        .filter((f) => f.path.toLowerCase().includes(q))
        .map((f) => f.path),
    );
  }, [graph.files, search]);

  const rfNodes = useMemo<Node[]>(() => {
    const hiddenFiles = new Set(
      onlyFindings
        ? graph.files.filter((f) => f.findings.length === 0).map((f) => f.path)
        : [],
    );
    const visibleDirs = new Set(
      graph.files.filter((f) => !hiddenFiles.has(f.path)).map((f) => f.dir),
    );
    const nodes: Node[] = graph.groups
      .map((g) => ({
        id: g.id,
        type: "groupBox",
        position: g.position,
        // Explicit width/height (not just style) — MiniMap skips nodes whose
        // user node lacks measured dimensions, which are never back-filled
        // for nodes sized through style alone.
        width: g.size.width,
        height: g.size.height,
        data: { label: g.label },
        // Node-level zIndex (not style) — React Flow uses it to order the
        // node in its pane, keeping edges above group boxes and under files.
        zIndex: -1,
        style: {
          width: g.size.width,
          height: g.size.height,
          pointerEvents: "none" as const,
        },
        selectable: false,
        draggable: false,
        connectable: false,
        // Group dir label is `group:<dir>`; hide when all its files are.
        hidden:
          onlyFindings &&
          !visibleDirs.has(g.id === "group:(root)" ? "" : g.id.slice(6)),
      }));
    for (const f of graph.files) {
      nodes.push({
        id: f.path,
        type: "file",
        position: f.position,
        width: FILE_NODE_WIDTH,
        height: FILE_NODE_HEIGHT,
        data: {
          file: f,
          selected: f.path === selectedPath,
          dimmed:
            (neighbors !== null && !neighbors.has(f.path)) ||
            (matched !== null && matched.size > 0 && !matched.has(f.path)),
          neighbor: neighbors?.has(f.path) === true && f.path !== focusPath,
          matched: matched?.has(f.path) === true,
        },
        hidden: hiddenFiles.has(f.path),
      } satisfies ReviewMapFileNode);
    }
    return nodes;
  }, [graph, selectedPath, focusPath, neighbors, matched, onlyFindings]);

  const rfEdges = useMemo<Edge[]>(() => {
    const visible = new Set(
      onlyFindings
        ? graph.files.filter((f) => f.findings.length > 0).map((f) => f.path)
        : graph.files.map((f) => f.path),
    );
    const posByPath = new Map(graph.files.map((f) => [f.path, f.position]));
    return graph.edges.map((e) => {
      const s = posByPath.get(e.source);
      const t = posByPath.get(e.target);
      const sides = s && t ? edgeSides(s, t) : { source: "right" as const, target: "left" as const };
      const active = focusPath !== null && (e.source === focusPath || e.target === focusPath);
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        // Same-column pairs attach right→right so the bezier loops out of the
        // column instead of cutting through the file nodes.
        sourceHandle: sides.source === "left" ? "l" : "r",
        targetHandle: sides.target === "left" ? "l" : "r",
        hidden: !visible.has(e.source) || !visible.has(e.target),
        markerEnd: { type: MarkerType.ArrowClosed },
        style: {
          stroke: active
            ? "hsl(var(--primary))"
            : "hsl(var(--muted-foreground))",
          strokeWidth: active ? 2 : 1.25,
          opacity: focusPath === null ? 0.7 : active ? 1 : 0.15,
        },
      };
    });
  }, [graph, focusPath, onlyFindings]);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      edgesReconnectable={false}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      minZoom={0.1}
      proOptions={{ hideAttribution: true }}
      onInit={onInit}
      onNodeClick={(_, node) => {
        if (node.type === "file") onSelect(node.id);
      }}
      onNodeMouseEnter={(_, node) => {
        if (node.type === "file") onHover(node.id);
      }}
      onNodeMouseLeave={() => onHover(null)}
      onPaneClick={() => onSelect(null)}
    >
      <Background />
      <Controls showInteractive={false} />
      <MiniMap
        className="!hidden md:!block"
        pannable
        zoomable
        nodeStrokeWidth={1}
        nodeColor={(n) =>
          n.type === "file"
            ? (MINIMAP_STATUS_COLOR[
                (n.data as { file?: { status?: string } }).file?.status ??
                  "modified"
              ] ?? "#2563eb")
            : "rgba(0,0,0,0.06)"
        }
      />
    </ReactFlow>
  );
}
