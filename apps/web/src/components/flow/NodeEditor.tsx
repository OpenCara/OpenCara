import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Cpu, ExternalLink, Plus, Sparkles, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  AgentRow,
  FlowGraph,
  FlowNodeSetting,
  FlowSummary,
  PromptRow,
  TemplateNodeSetting,
} from "@/lib/queries";

const NONE = "__none__";

/**
 * Where the editor's mutations should land. The two scopes share a UI
 * (panels + controls) but write to different routes — project edits go to
 * the project's flow row, template edits go to the user's template draft.
 */
export type EditorScope =
  | { kind: "project"; projectId: string; slug: string; flowId: string }
  | { kind: "template"; slug: string };

export interface NodeEditorNode {
  id: string;
  kind: string;
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
}

interface NodeEditorProps {
  scope: EditorScope;
  graph: FlowGraph;
  selectedNode: NodeEditorNode | null;
  settings: NodeSetting[];
  agents: AgentRow[];
  prompts: PromptRow[];
  /** Whether to render the "Add reviewer / Remove selected reviewer" bar. */
  showReviewerControls: boolean;
  /** Called after a successful reviewer remove so the parent can clear selection. */
  onSelectedNodeRemoved: () => void;
  onClose: () => void;
}

type NodeSetting = FlowNodeSetting | TemplateNodeSetting;

export function NodeEditor({
  scope,
  graph,
  selectedNode,
  settings,
  agents,
  prompts,
  showReviewerControls,
  onSelectedNodeRemoved,
  onClose,
}: NodeEditorProps) {
  const reviewerNodeIds = showReviewerControls ? deriveReviewerIds(graph) : new Set<string>();
  const reviewerCount = reviewerNodeIds.size;
  const selectedIsReviewer = selectedNode ? reviewerNodeIds.has(selectedNode.id) : false;

  return (
    <>
      {showReviewerControls && (
        <ReviewerControls
          scope={scope}
          reviewerCount={reviewerCount}
          selectedReviewerId={selectedIsReviewer ? selectedNode!.id : null}
          onRemoved={onSelectedNodeRemoved}
        />
      )}
      {selectedNode && selectedNode.kind === "agent" && (
        <AgentNodePanel
          scope={scope}
          node={selectedNode}
          settings={settings}
          prompts={prompts}
          agents={agents}
          onClose={onClose}
        />
      )}
      {selectedNode && selectedNode.kind === "github.pull_request" && (
        <TriggerNodePanel scope={scope} node={selectedNode} onClose={onClose} />
      )}
      {selectedNode &&
        selectedNode.kind !== "agent" &&
        selectedNode.kind !== "github.pull_request" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{selectedNode.kind}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              This node has no configurable settings yet.
            </CardContent>
          </Card>
        )}
    </>
  );
}

/* ─── Mutations (scope-aware) ────────────────────────────────────── */

interface SetSettingsVars {
  nodeId: string;
  promptId?: string | null;
  agentId?: string | null;
  label?: string | null;
}

function useSetSettings(scope: EditorScope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: SetSettingsVars) => {
      const body: Record<string, string | null> = {};
      if (vars.promptId !== undefined) body.promptId = vars.promptId;
      if (vars.agentId !== undefined) body.agentId = vars.agentId;
      if (vars.label !== undefined) body.label = vars.label;
      const url =
        scope.kind === "project"
          ? `/api/projects/${scope.projectId}/flows/${scope.flowId}/nodes/${vars.nodeId}/settings`
          : `/api/flow-templates/${scope.slug}/nodes/${vars.nodeId}/settings`;
      return api.put<{ setting: NodeSetting }>(url, body);
    },
    onSuccess: () => invalidateScope(qc, scope, ["settings"]),
  });
}

interface SetConfigVars {
  nodeId: string;
  config: unknown;
}

function useSetNodeConfig(scope: EditorScope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: SetConfigVars) => {
      const url =
        scope.kind === "project"
          ? `/api/projects/${scope.projectId}/flows/${scope.flowId}/nodes/${vars.nodeId}/config`
          : `/api/flow-templates/${scope.slug}/nodes/${vars.nodeId}/config`;
      return api.patch<{ flow?: FlowSummary; template?: unknown }>(url, {
        config: vars.config,
      });
    },
    onSuccess: () => invalidateScope(qc, scope, ["graph", "settings"]),
  });
}

function useAddReviewer(scope: EditorScope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => {
      const url =
        scope.kind === "project"
          ? `/api/projects/${scope.projectId}/flows/${scope.flowId}/reviewers`
          : `/api/flow-templates/${scope.slug}/reviewers`;
      return api.post<{ addedNodeId: string }>(url);
    },
    onSuccess: () => invalidateScope(qc, scope, ["graph"]),
  });
}

function useRemoveReviewer(scope: EditorScope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { nodeId: string }) => {
      const url =
        scope.kind === "project"
          ? `/api/projects/${scope.projectId}/flows/${scope.flowId}/reviewers/${vars.nodeId}`
          : `/api/flow-templates/${scope.slug}/reviewers/${vars.nodeId}`;
      return api.delete(url);
    },
    onSuccess: () => invalidateScope(qc, scope, ["graph", "settings"]),
  });
}

function invalidateScope(
  qc: ReturnType<typeof useQueryClient>,
  scope: EditorScope,
  what: Array<"graph" | "settings">,
) {
  if (scope.kind === "project") {
    if (what.includes("graph")) {
      qc.invalidateQueries({
        queryKey: ["projects", scope.projectId, "flows", scope.slug],
      });
      qc.invalidateQueries({ queryKey: ["projects", scope.projectId, "flows"] });
    }
    if (what.includes("settings")) {
      qc.invalidateQueries({
        queryKey: ["projects", scope.projectId, "flows", scope.flowId, "node-settings"],
      });
    }
  } else {
    // Template detail returns graph + settings together; one invalidation covers both.
    qc.invalidateQueries({ queryKey: ["flow-templates", scope.slug] });
  }
}

/* ─── Agent node panel ──────────────────────────────────────────── */

interface AgentNodePanelProps {
  scope: EditorScope;
  node: NodeEditorNode;
  settings: NodeSetting[];
  prompts: PromptRow[];
  agents: AgentRow[];
  onClose: () => void;
}

function AgentNodePanel({
  scope,
  node,
  settings,
  prompts,
  agents,
  onClose,
}: AgentNodePanelProps) {
  const setting = settings.find((s) => s.nodeId === node.id);
  const linkedPromptId = setting?.promptId ?? null;
  const linkedAgentId = setting?.agentId ?? null;
  const linkedPrompt = linkedPromptId
    ? prompts.find((p) => p.id === linkedPromptId) ?? null
    : null;
  const linkedAgent = linkedAgentId
    ? agents.find((a) => a.id === linkedAgentId) ?? null
    : null;
  const set = useSetSettings(scope);

  const cfg = (node.config ?? {}) as { label?: string };
  const defaultLabel = cfg.label ?? "Agent";
  const customLabel = setting?.label ?? null;

  const [labelDraft, setLabelDraft] = useState(customLabel ?? "");
  useEffect(() => {
    setLabelDraft(customLabel ?? "");
  }, [node.id, customLabel]);

  const commitLabel = () => {
    const trimmed = labelDraft.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next === customLabel) return;
    set.mutate({ nodeId: node.id, label: next });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">
              {customLabel ?? defaultLabel}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                #{node.id}
              </span>
            </CardTitle>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <div className="text-sm font-medium">Display name</div>
          <Input
            value={labelDraft}
            placeholder={defaultLabel}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
            }}
            className="max-w-md"
          />
          <p className="text-xs text-muted-foreground">
            Shown on the graph + used as a section heading when feeding a synthesizer.
            Empty resets to "{defaultLabel}".
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-1 text-sm font-medium">
            <Cpu className="size-3.5" />
            Linked agent
            <span className="text-xs font-normal text-muted-foreground">(required)</span>
          </div>
          <Select
            value={linkedAgentId ?? NONE}
            onValueChange={(v) => {
              set.mutate({ nodeId: node.id, agentId: v === NONE ? null : v });
            }}
          >
            <SelectTrigger className="w-full max-w-md">
              <SelectValue placeholder="(none — runs will fail)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>(none — runs will fail)</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {agents.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No agents yet.{" "}
              <Link to="/agents" className="text-foreground underline">
                Create one
              </Link>{" "}
              before this flow can run.
            </p>
          )}
          {linkedAgent && (
            <pre className="mt-2 rounded-md border bg-muted/30 p-3 font-mono text-xs">
              $ {linkedAgent.command}
              {linkedAgent.args.length ? " " : ""}
              {linkedAgent.args.join(" ")}
              <span className="ml-2 text-muted-foreground">
                [device: {linkedAgent.hostId ? linkedAgent.hostId.slice(-8) : "any"}]
              </span>
            </pre>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-1 text-sm font-medium">
            <Sparkles className="size-3.5" />
            Linked prompt
            <span className="text-xs font-normal text-muted-foreground">(optional)</span>
          </div>
          <Select
            value={linkedPromptId ?? NONE}
            onValueChange={(v) => {
              set.mutate({ nodeId: node.id, promptId: v === NONE ? null : v });
            }}
          >
            <SelectTrigger className="w-full max-w-md">
              <SelectValue placeholder="(none)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>(none)</SelectItem>
              {prompts.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {prompts.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No prompts yet.{" "}
              <Link to="/prompts" className="text-foreground underline">
                Create one
              </Link>
              .
            </p>
          )}
          {linkedPrompt && (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs">
              {linkedPrompt.body}
            </pre>
          )}
          {set.error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              Save failed.
            </div>
          )}
          <Link
            to="/prompts"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Manage prompts <ExternalLink className="size-3" />
          </Link>
        </div>

        <AgentWorktreeSection scope={scope} node={node} />
      </CardContent>
    </Card>
  );
}

/* ─── Worktree sub-section on the agent panel ──────────────────── */

interface AgentWorktreeSectionProps {
  scope: EditorScope;
  node: NodeEditorNode;
}

function AgentWorktreeSection({ scope, node }: AgentWorktreeSectionProps) {
  // The worktree option lives on agent.config.worktree. node.config
  // is whatever's stored in graph_json — we read existing values
  // and on Save send the FULL config (preserving label, spec,
  // contextInjection) so we don't clobber unrelated keys.
  const cfg = (node.config ?? {}) as {
    label?: string;
    spec?: unknown;
    contextInjection?: unknown;
    worktree?: { fromBranch?: string | null; branchName?: string; hostId?: string | null };
  };
  const wt = cfg.worktree;
  const [enabled, setEnabled] = useState(Boolean(wt));
  const [fromBranch, setFromBranch] = useState(wt?.fromBranch ?? "");
  const [branchName, setBranchName] = useState(
    wt?.branchName ?? "opencara/issue-{{OPENCARA_ISSUE_NUMBER}}",
  );
  const [hostId, setHostId] = useState(wt?.hostId ?? "");
  const set = useSetNodeConfig(scope);

  useEffect(() => {
    setEnabled(Boolean(wt));
    setFromBranch(wt?.fromBranch ?? "");
    setBranchName(wt?.branchName ?? "opencara/issue-{{OPENCARA_ISSUE_NUMBER}}");
    setHostId(wt?.hostId ?? "");
  }, [node.id, wt?.fromBranch, wt?.branchName, wt?.hostId, wt]);

  const save = () => {
    // Preserve label/spec/contextInjection (not mutated here) and
    // write the worktree subfield. Pass the entire object back; the
    // server replaces node.config wholesale.
    const nextConfig: Record<string, unknown> = {
      label: cfg.label,
      spec: cfg.spec,
      contextInjection: cfg.contextInjection,
    };
    if (enabled) {
      if (!branchName.trim()) return;
      nextConfig.worktree = {
        fromBranch: fromBranch.trim().length > 0 ? fromBranch.trim() : null,
        branchName: branchName.trim(),
        hostId: hostId.trim().length > 0 ? hostId.trim() : null,
      };
    }
    // (When enabled = false, we omit the field; node.config.worktree
    // is optional in the schema.)
    set.mutate({ nodeId: node.id, config: nextConfig });
  };

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="size-4 rounded border-input"
        />
        <span>Run in a per-PR-branch worktree</span>
      </label>
      <p className="text-xs text-muted-foreground">
        Allocates a stable git checkout on a paired device, keyed by{" "}
        <code className="font-mono">(repo, branch)</code>. The same branch
        across the implement and review-fix flows reuses the same checkout
        and the agent's prior session id; removed on{" "}
        <code className="font-mono">pull_request.closed</code>.
      </p>
      {enabled && (
        <div className="space-y-3 rounded-md border bg-muted/20 p-3">
          <div>
            <Label>Branch name</Label>
            <Input
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              placeholder="opencara/issue-{{OPENCARA_ISSUE_NUMBER}}"
              className="mt-1 font-mono text-xs"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Template; supports <code className="font-mono">{`{{ENV_VAR}}`}</code>{" "}
              substitution against the run env.
            </p>
          </div>
          <div>
            <Label>From branch</Label>
            <Input
              value={fromBranch}
              onChange={(e) => setFromBranch(e.target.value)}
              placeholder="(repo default)"
              className="mt-1 font-mono text-xs"
            />
          </div>
          <div>
            <Label>Pin to device (host id)</Label>
            <Input
              value={hostId}
              onChange={(e) => setHostId(e.target.value)}
              placeholder="(any idle device or persisted pin)"
              className="mt-1 font-mono text-xs"
            />
          </div>
        </div>
      )}
      {set.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {(set.error as Error).message ?? "Save failed"}
        </div>
      )}
      <div className="flex justify-end">
        <Button size="sm" disabled={set.isPending} onClick={save}>
          {set.isPending ? "Saving…" : "Save worktree"}
        </Button>
      </div>
    </div>
  );
}

/* ─── Trigger node panel ────────────────────────────────────────── */

interface TriggerNodePanelProps {
  scope: EditorScope;
  node: NodeEditorNode;
  onClose: () => void;
}

const TRIGGER_ACTIONS = [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
] as const;
type TriggerAction = (typeof TRIGGER_ACTIONS)[number];

interface TriggerCfg {
  actions: TriggerAction[];
  branches: string[];
  branchesIgnore: string[];
  paths: string[];
  pathsIgnore: string[];
  labels: string[];
  labelsIgnore: string[];
  ignoreDrafts: boolean;
}

function readStringArray(o: Record<string, unknown>, key: string): string[] {
  const v = o[key];
  return Array.isArray(v)
    ? v.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readTriggerConfig(raw: unknown): TriggerCfg {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const actions = (Array.isArray(o.actions) ? o.actions : []).filter(
    (v): v is TriggerAction => TRIGGER_ACTIONS.includes(v as TriggerAction),
  );
  return {
    actions: actions.length ? actions : ["opened", "synchronize", "reopened"],
    branches: readStringArray(o, "branches"),
    branchesIgnore: readStringArray(o, "branchesIgnore"),
    paths: readStringArray(o, "paths"),
    pathsIgnore: readStringArray(o, "pathsIgnore"),
    labels: readStringArray(o, "labels"),
    labelsIgnore: readStringArray(o, "labelsIgnore"),
    ignoreDrafts: o.ignoreDrafts === true,
  };
}

function TriggerNodePanel({ scope, node, onClose }: TriggerNodePanelProps) {
  const initial = useMemo(() => readTriggerConfig(node.config), [node.config]);
  const [actions, setActions] = useState<TriggerAction[]>(initial.actions);
  const [branches, setBranches] = useState(initial.branches.join(", "));
  const [branchesIgnore, setBranchesIgnore] = useState(initial.branchesIgnore.join(", "));
  const [paths, setPaths] = useState(initial.paths.join(", "));
  const [pathsIgnore, setPathsIgnore] = useState(initial.pathsIgnore.join(", "));
  const [labels, setLabels] = useState(initial.labels.join(", "));
  const [labelsIgnore, setLabelsIgnore] = useState(initial.labelsIgnore.join(", "));
  const [ignoreDrafts, setIgnoreDrafts] = useState(initial.ignoreDrafts);
  const set = useSetNodeConfig(scope);

  useEffect(() => {
    setActions(initial.actions);
    setBranches(initial.branches.join(", "));
    setBranchesIgnore(initial.branchesIgnore.join(", "));
    setPaths(initial.paths.join(", "));
    setPathsIgnore(initial.pathsIgnore.join(", "));
    setLabels(initial.labels.join(", "));
    setLabelsIgnore(initial.labelsIgnore.join(", "));
    setIgnoreDrafts(initial.ignoreDrafts);
  }, [initial]);

  const toggleAction = (action: TriggerAction) => {
    setActions((prev) =>
      prev.includes(action) ? prev.filter((x) => x !== action) : [...prev, action],
    );
  };

  const handleSave = () => {
    if (actions.length === 0) return;
    set.mutate({
      nodeId: node.id,
      config: {
        actions,
        branches: parseList(branches),
        branchesIgnore: parseList(branchesIgnore),
        paths: parseList(paths),
        pathsIgnore: parseList(pathsIgnore),
        labels: parseList(labels),
        labelsIgnore: parseList(labelsIgnore),
        ignoreDrafts,
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Pull request trigger</CardTitle>
            <p className="text-xs text-muted-foreground">
              Filters borrowed from GitHub Actions'{" "}
              <code className="font-mono">on.pull_request</code>.
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <div className="text-sm font-medium">Action types</div>
          <div className="flex flex-wrap gap-2">
            {TRIGGER_ACTIONS.map((action) => {
              const isActive = actions.includes(action);
              return (
                <button
                  key={action}
                  type="button"
                  onClick={() => toggleAction(action)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs",
                    isActive
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-muted/30 text-muted-foreground hover:border-foreground/40",
                  )}
                >
                  {action}
                </button>
              );
            })}
          </div>
          {actions.length === 0 && (
            <p className="text-xs text-destructive">Pick at least one action type.</p>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={ignoreDrafts}
            onChange={(e) => setIgnoreDrafts(e.target.checked)}
            className="size-4 rounded border-input"
          />
          <span className="font-medium">Ignore draft PRs</span>
          <span className="text-xs text-muted-foreground">
            Skips when <code className="font-mono">pull_request.draft === true</code>.
          </span>
        </label>

        <div className="grid gap-3 md:grid-cols-2">
          <ChipField
            label="Branches"
            placeholder="main, release/*"
            help="PR base ref must match one of these (glob)."
            value={branches}
            onChange={setBranches}
          />
          <ChipField
            label="Branches ignore"
            placeholder="dependabot/**"
            help="PR is skipped when base ref matches any of these."
            value={branchesIgnore}
            onChange={setBranchesIgnore}
          />
          <ChipField
            label="Paths"
            placeholder="src/**, *.md"
            help="At least one changed file must match (glob, ** crosses /)."
            value={paths}
            onChange={setPaths}
          />
          <ChipField
            label="Paths ignore"
            placeholder="docs/**, *.lock"
            help="PR is skipped when every changed file matches."
            value={pathsIgnore}
            onChange={setPathsIgnore}
          />
          <ChipField
            label="Labels"
            placeholder="needs-review, security"
            help="PR must carry at least one of these labels."
            value={labels}
            onChange={setLabels}
          />
          <ChipField
            label="Labels ignore"
            placeholder="wip, do-not-review"
            help="PR is skipped when it carries any of these labels."
            value={labelsIgnore}
            onChange={setLabelsIgnore}
          />
        </div>

        {set.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {(set.error as Error).message ?? "Save failed"}
          </div>
        )}

        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={actions.length === 0 || set.isPending}
            onClick={handleSave}
          >
            {set.isPending ? "Saving…" : "Save filters"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}


interface ChipFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  help?: string;
}

function ChipField({ label, value, onChange, placeholder, help }: ChipFieldProps) {
  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 font-mono text-xs"
      />
      {help && <p className="mt-1 text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

function parseList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ─── Reviewer add/remove controls ──────────────────────────────── */

interface ReviewerControlsProps {
  scope: EditorScope;
  reviewerCount: number;
  selectedReviewerId: string | null;
  onRemoved: () => void;
}

function ReviewerControls({
  scope,
  reviewerCount,
  selectedReviewerId,
  onRemoved,
}: ReviewerControlsProps) {
  const add = useAddReviewer(scope);
  const remove = useRemoveReviewer(scope);
  const error = add.error ?? remove.error;
  return (
    <div className="flex items-center gap-3">
      <Button
        size="sm"
        variant="outline"
        onClick={() => add.mutate()}
        disabled={add.isPending}
      >
        <Plus className="size-3.5" />
        {add.isPending ? "Adding…" : "Add reviewer"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          if (!selectedReviewerId) return;
          remove.mutate(
            { nodeId: selectedReviewerId },
            { onSuccess: onRemoved },
          );
        }}
        disabled={
          remove.isPending || !selectedReviewerId || reviewerCount <= 1
        }
        title={
          !selectedReviewerId
            ? "Click a reviewer node first"
            : reviewerCount <= 1
              ? "Cannot remove the last reviewer"
              : "Remove the selected reviewer"
        }
      >
        <Trash2 className="size-3.5" />
        {remove.isPending ? "Removing…" : "Remove selected reviewer"}
      </Button>
      <span className="text-xs text-muted-foreground">
        {reviewerCount} reviewer{reviewerCount === 1 ? "" : "s"}
      </span>
      {error && (
        <span className="text-xs text-destructive">{(error as Error).message}</span>
      )}
    </div>
  );
}

/* ─── Reviewer detection ────────────────────────────────────────── */

/**
 * A "reviewer" node, in the multi-agent review flow, is any agent node that
 * sits between the trigger and the synthesizer (i.e. has trigger as an
 * upstream AND synthesizer as a downstream). This is purely structural so it
 * survives graph customisation (added reviewers retain the role).
 */
export function deriveReviewerIds(graph: {
  nodes: Array<{ id: string; kind: string }>;
  edges: Array<{ source: string; target: string }>;
}): Set<string> {
  const trigger = graph.nodes.find((n) => n.kind === "github.pull_request");
  const synth = graph.nodes.find(
    (n) => n.kind === "agent" && (n.id === "synthesizer" || /synth/i.test(n.id)),
  );
  if (!trigger || !synth) return new Set();
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (n.kind !== "agent") continue;
    if (n.id === synth.id) continue;
    const fromTrigger = graph.edges.some((e) => e.source === trigger.id && e.target === n.id);
    const toSynth = graph.edges.some((e) => e.source === n.id && e.target === synth.id);
    if (fromTrigger && toSynth) ids.add(n.id);
  }
  return ids;
}
