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
      {selectedNode && selectedNode.kind === "github.pull_request_review" && (
        <PullRequestReviewTriggerPanel scope={scope} node={selectedNode} onClose={onClose} />
      )}
      {selectedNode && selectedNode.kind === "github.projects_v2_item" && (
        <ProjectsV2ItemTriggerPanel scope={scope} node={selectedNode} onClose={onClose} />
      )}
      {selectedNode &&
        selectedNode.kind !== "agent" &&
        selectedNode.kind !== "github.pull_request" &&
        selectedNode.kind !== "github.pull_request_review" &&
        selectedNode.kind !== "github.projects_v2_item" && (
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

        <AgentDraftPrToggle scope={scope} node={node} />
        <AgentAutoMergeSection scope={scope} node={node} />
        <AgentMaxIterationsSection scope={scope} node={node} />
        <AgentWorktreeSection scope={scope} node={node} />

        <AgentNodeInspector node={node} />
      </CardContent>
    </Card>
  );
}

/* ─── Draft PR toggle on the agent panel ───────────────────────── */

interface AgentDraftPrToggleProps {
  scope: EditorScope;
  node: NodeEditorNode;
}

function AgentDraftPrToggle({ scope, node }: AgentDraftPrToggleProps) {
  const cfg = (node.config ?? {}) as {
    draftPr?: boolean;
    worktree?: unknown;
  };
  const [enabled, setEnabled] = useState(Boolean(cfg.draftPr));
  const set = useSetNodeConfig(scope);

  useEffect(() => {
    setEnabled(Boolean(cfg.draftPr));
  }, [node.id, cfg.draftPr]);

  if (!cfg.worktree) return null;

  const save = () => {
    set.mutate({
      nodeId: node.id,
      config: {
        ...(node.config ?? {}),
        draftPr: enabled,
      },
    });
  };

  return (
    <div className="space-y-2 rounded-md border bg-muted/10 p-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="size-4 rounded border-input"
        />
        <span>Create draft PR</span>
      </label>
      <p className="text-xs text-muted-foreground">
        Instructs the agent to open the PR with <code className="font-mono">--draft</code>.
        After a successful run, the engine marks the branch's open draft PR
        ready for review.
      </p>
      {set.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {(set.error as Error).message ?? "Save failed"}
        </div>
      )}
      <div className="flex justify-end">
        <Button size="sm" disabled={set.isPending} onClick={save}>
          {set.isPending ? "Saving…" : "Save draft PR"}
        </Button>
      </div>
    </div>
  );
}

/* ─── Auto-merge section on the agent panel ───────────────────── */

interface AgentAutoMergeSectionProps {
  scope: EditorScope;
  node: NodeEditorNode;
}

function AgentAutoMergeSection({ scope, node }: AgentAutoMergeSectionProps) {
  const cfg = (node.config ?? {}) as {
    autoMerge?: {
      enabled?: boolean;
      method?: "squash" | "merge" | "rebase";
      requireChecks?: boolean;
      requireApproval?: boolean;
      mergeWithoutChanges?: boolean;
    };
  };
  const am = cfg.autoMerge;
  const [enabled, setEnabled] = useState(Boolean(am?.enabled));
  const [method, setMethod] = useState<"squash" | "merge" | "rebase">(
    am?.method ?? "squash",
  );
  const [requireChecks, setRequireChecks] = useState(
    am?.requireChecks ?? true,
  );
  const [requireApproval, setRequireApproval] = useState(
    Boolean(am?.requireApproval),
  );
  const [mergeWithoutChanges, setMergeWithoutChanges] = useState(
    Boolean(am?.mergeWithoutChanges),
  );
  const set = useSetNodeConfig(scope);

  useEffect(() => {
    setEnabled(Boolean(am?.enabled));
    setMethod(am?.method ?? "squash");
    setRequireChecks(am?.requireChecks ?? true);
    setRequireApproval(Boolean(am?.requireApproval));
    setMergeWithoutChanges(Boolean(am?.mergeWithoutChanges));
  }, [
    node.id,
    am?.enabled,
    am?.method,
    am?.requireChecks,
    am?.requireApproval,
    am?.mergeWithoutChanges,
  ]);

  if (!am) return null;

  const save = () => {
    set.mutate({
      nodeId: node.id,
      config: {
        ...(node.config ?? {}),
        autoMerge: {
          enabled,
          method,
          requireChecks,
          requireApproval,
          mergeWithoutChanges,
        },
      },
    });
  };

  return (
    <div className="space-y-2 rounded-md border bg-muted/10 p-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="size-4 rounded border-input"
        />
        <span>Auto-merge after fix</span>
      </label>
      <p className="text-xs text-muted-foreground">
        When the fix agent exits successfully, attempt to merge the PR
        automatically. All other merge gates (mergeable state, checks, reviews)
        still apply.
      </p>
      {enabled && (
        <div className="space-y-3 rounded-md border bg-muted/20 p-3">
          <div>
            <Label>Merge method</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="squash">Squash</SelectItem>
                <SelectItem value="merge">Merge commit</SelectItem>
                <SelectItem value="rebase">Rebase</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={requireChecks}
              onChange={(e) => setRequireChecks(e.target.checked)}
              className="size-4 rounded border-input"
            />
            <span>Require passing checks</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={requireApproval}
              onChange={(e) => setRequireApproval(e.target.checked)}
              className="size-4 rounded border-input"
            />
            <span>Require approving review</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={mergeWithoutChanges}
              onChange={(e) => setMergeWithoutChanges(e.target.checked)}
              className="size-4 rounded border-input"
            />
            <span>Merge even without new commits</span>
          </label>
          <p className="text-xs text-muted-foreground">
            When enabled, bypasses the &ldquo;no new HEAD commit&rdquo; check.
            Useful when the reviewer loop ends with &ldquo;nothing to
            fix&rdquo; and you want to merge the PR as-is.
          </p>
        </div>
      )}
      {set.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {(set.error as Error).message ?? "Save failed"}
        </div>
      )}
      <div className="flex justify-end">
        <Button size="sm" disabled={set.isPending} onClick={save}>
          {set.isPending ? "Saving…" : "Save auto-merge"}
        </Button>
      </div>
    </div>
  );
}

/* ─── Max iterations section on the agent panel ───────────────── */

interface AgentMaxIterationsSectionProps {
  scope: EditorScope;
  node: NodeEditorNode;
}

function AgentMaxIterationsSection({ scope, node }: AgentMaxIterationsSectionProps) {
  const cfg = (node.config ?? {}) as {
    maxIterations?: {
      enabled?: boolean;
      limit?: number | null;
      commentOnSkip?: boolean;
    };
  };
  const mi = cfg.maxIterations;
  const [enabled, setEnabled] = useState(Boolean(mi?.enabled));
  const [limit, setLimit] = useState<string>(
    mi?.limit != null ? String(mi.limit) : "",
  );
  const [commentOnSkip, setCommentOnSkip] = useState(
    Boolean(mi?.commentOnSkip),
  );
  const set = useSetNodeConfig(scope);

  useEffect(() => {
    setEnabled(Boolean(mi?.enabled));
    setLimit(mi?.limit != null ? String(mi.limit) : "");
    setCommentOnSkip(Boolean(mi?.commentOnSkip));
  }, [node.id, mi?.enabled, mi?.limit, mi?.commentOnSkip]);

  if (!mi) return null;

  const save = () => {
    const parsedLimit = limit.trim() === "" ? null : parseInt(limit, 10);
    set.mutate({
      nodeId: node.id,
      config: {
        ...(node.config ?? {}),
        maxIterations: {
          enabled,
          limit: parsedLimit != null && !isNaN(parsedLimit) ? parsedLimit : null,
          commentOnSkip,
        },
      },
    });
  };

  return (
    <div className="space-y-2 rounded-md border bg-muted/10 p-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="size-4 rounded border-input"
        />
        <span>Limit review-fix iterations</span>
      </label>
      <p className="text-xs text-muted-foreground">
        Cap the number of automated fix runs per PR. Once the limit is reached,
        further review comments will not dispatch until the count resets.
      </p>
      {enabled && (
        <div className="space-y-3 rounded-md border bg-muted/20 p-3">
          <div>
            <Label>Max iterations</Label>
            <Input
              type="number"
              min={0}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="(unlimited)"
              className="mt-1 w-32 font-mono text-xs"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Leave empty for unlimited.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={commentOnSkip}
              onChange={(e) => setCommentOnSkip(e.target.checked)}
              className="size-4 rounded border-input"
            />
            <span>Post comment when skipping</span>
          </label>
          <p className="text-xs text-muted-foreground">
            When the limit is hit, post a comment on the PR explaining why
            further fix runs were skipped.
          </p>
        </div>
      )}
      {set.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {(set.error as Error).message ?? "Save failed"}
        </div>
      )}
      <div className="flex justify-end">
        <Button size="sm" disabled={set.isPending} onClick={save}>
          {set.isPending ? "Saving…" : "Save max iterations"}
        </Button>
      </div>
    </div>
  );
}

/* ─── Raw-config inspector ──────────────────────────────────────── */

// Read-only pretty-printed JSON of the agent node's stored config.
// The form above only renders fields it knows about, so optional
// blocks (worktree.cacheRepo, etc.) can be
// hard to verify saved correctly without poking the DB. This panel
// is that check, in the editor itself.
function AgentNodeInspector({ node }: { node: NodeEditorNode }) {
  const json = JSON.stringify(node.config ?? {}, null, 2);
  return (
    <details className="rounded-md border bg-muted/10">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
        Raw config
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          (read-only)
        </span>
      </summary>
      <pre className="max-h-96 overflow-auto whitespace-pre border-t bg-muted/30 p-3 font-mono text-xs">
        {json}
      </pre>
    </details>
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
  // and on Save send the FULL config (preserving label,
  // contextInjection) so we don't clobber unrelated keys.
  const cfg = (node.config ?? {}) as {
    label?: string;
    draftPr?: boolean;
    contextInjection?: unknown;
    worktree?: {
      fromBranch?: string | null;
      branchName?: string;
      hostId?: string | null;
      cacheRepo?: { enabled?: boolean; lfs?: boolean };
    };
  };
  const wt = cfg.worktree;
  const [enabled, setEnabled] = useState(Boolean(wt));
  const [fromBranch, setFromBranch] = useState(wt?.fromBranch ?? "");
  const [branchName, setBranchName] = useState(
    wt?.branchName ?? "opencara/issue-{{OPENCARA_ISSUE_NUMBER}}",
  );
  const [hostId, setHostId] = useState(wt?.hostId ?? "");
  const [cacheRepo, setCacheRepo] = useState(Boolean(wt?.cacheRepo?.enabled));
  const [cacheLfs, setCacheLfs] = useState(Boolean(wt?.cacheRepo?.lfs));
  const set = useSetNodeConfig(scope);

  useEffect(() => {
    setEnabled(Boolean(wt));
    setFromBranch(wt?.fromBranch ?? "");
    setBranchName(wt?.branchName ?? "opencara/issue-{{OPENCARA_ISSUE_NUMBER}}");
    setHostId(wt?.hostId ?? "");
    setCacheRepo(Boolean(wt?.cacheRepo?.enabled));
    setCacheLfs(Boolean(wt?.cacheRepo?.lfs));
  }, [
    node.id,
    wt?.fromBranch,
    wt?.branchName,
    wt?.hostId,
    wt?.cacheRepo?.enabled,
    wt?.cacheRepo?.lfs,
    wt,
  ]);

  const save = () => {
    // Preserve label/contextInjection (not mutated here) and write
    // the worktree subfield. Pass the entire object back; the server
    // replaces node.config wholesale.
    const nextConfig: Record<string, unknown> = {
      ...(node.config ?? {}),
      label: cfg.label,
      draftPr: Boolean(cfg.draftPr),
      contextInjection: cfg.contextInjection,
    };
    if (enabled) {
      if (!branchName.trim()) return;
      const wtNext: Record<string, unknown> = {
        fromBranch: fromBranch.trim().length > 0 ? fromBranch.trim() : null,
        branchName: branchName.trim(),
        hostId: hostId.trim().length > 0 ? hostId.trim() : null,
      };
      if (cacheRepo) {
        // Omit the field entirely when disabled so saved JSON stays
        // minimal and matches the schema's "optional" shape.
        wtNext.cacheRepo = { enabled: true, lfs: cacheLfs };
      }
      nextConfig.worktree = wtNext;
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
          <div className="space-y-2 border-t pt-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={cacheRepo}
                onChange={(e) => setCacheRepo(e.target.checked)}
                className="size-4 rounded border-input"
              />
              <span>Cache repo on host</span>
            </label>
            <p className="text-xs text-muted-foreground">
              Keeps a single full clone at{" "}
              <code className="font-mono">~/.opencara/cache/&lt;owner&gt;/&lt;repo&gt;</code>{" "}
              and clones each per-PR-branch checkout with{" "}
              <code className="font-mono">--reference</code>, sharing pack files.
              Persists across PR closes.
            </p>
            <label
              className={`flex items-center gap-2 text-sm font-medium ${
                cacheRepo ? "" : "opacity-50"
              }`}
            >
              <input
                type="checkbox"
                checked={cacheLfs}
                disabled={!cacheRepo}
                onChange={(e) => setCacheLfs(e.target.checked)}
                className="size-4 rounded border-input"
              />
              <span>Include Git LFS</span>
            </label>
            <p className="text-xs text-muted-foreground">
              When off, sets{" "}
              <code className="font-mono">GIT_LFS_SKIP_SMUDGE=1</code> on every
              git op (pointers only). When on, the cache fetches all LFS blobs
              and each checkout symlinks{" "}
              <code className="font-mono">.git/lfs/objects</code> at the cache so
              smudge resolves locally.
            </p>
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
  "commented",
] as const;
type TriggerAction = (typeof TRIGGER_ACTIONS)[number];

const DEFAULT_COMMENT_PHRASE = "@opencara review";

interface TriggerCfg {
  actions: TriggerAction[];
  branches: string[];
  branchesIgnore: string[];
  paths: string[];
  pathsIgnore: string[];
  labels: string[];
  labelsIgnore: string[];
  ignoreDrafts: boolean;
  commentPhrase: string;
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
    commentPhrase:
      typeof o.commentPhrase === "string" ? o.commentPhrase : DEFAULT_COMMENT_PHRASE,
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
  const [commentPhrase, setCommentPhrase] = useState(initial.commentPhrase);
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
    setCommentPhrase(initial.commentPhrase);
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
        commentPhrase: commentPhrase.trim() || DEFAULT_COMMENT_PHRASE,
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

        {actions.includes("commented") && (
          <div className="space-y-1">
            <div className="text-sm font-medium">Comment phrase</div>
            <Input
              value={commentPhrase}
              placeholder={DEFAULT_COMMENT_PHRASE}
              onChange={(e) => setCommentPhrase(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Fires on <code className="font-mono">issue_comment.created</code> when the
              comment body contains this text (case-insensitive). Branches / paths /
              labels / drafts filters are skipped on this path. Empty saves as{" "}
              <code className="font-mono">{DEFAULT_COMMENT_PHRASE}</code>.
            </p>
          </div>
        )}

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

/* ─── github.pull_request_review trigger panel ────────────────── */

const REVIEW_STATES = ["approved", "changes_requested", "commented", "dismissed"] as const;
type ReviewState = (typeof REVIEW_STATES)[number];

interface PRReviewTriggerPanelProps {
  scope: EditorScope;
  node: NodeEditorNode;
  onClose: () => void;
}

function PullRequestReviewTriggerPanel({ scope, node, onClose }: PRReviewTriggerPanelProps) {
  const cfg = (node.config ?? {}) as {
    reviewStates?: ReviewState[];
    users?: string[];
    commentPhrase?: string;
  };
  const initialStates = useMemo<ReviewState[]>(
    () => cfg.reviewStates ?? ["commented", "changes_requested"],
    [cfg.reviewStates],
  );
  const initialUsers = useMemo(() => (cfg.users ?? ["opencara[bot]"]).join(", "), [cfg.users]);
  const initialCommentPhrase = useMemo(
    () => (typeof cfg.commentPhrase === "string" ? cfg.commentPhrase : ""),
    [cfg.commentPhrase],
  );
  const [states, setStates] = useState<ReviewState[]>(initialStates);
  const [users, setUsers] = useState(initialUsers);
  const [commentPhrase, setCommentPhrase] = useState(initialCommentPhrase);
  const set = useSetNodeConfig(scope);

  useEffect(() => {
    setStates(initialStates);
    setUsers(initialUsers);
    setCommentPhrase(initialCommentPhrase);
  }, [initialStates, initialUsers, initialCommentPhrase]);

  const toggle = (s: ReviewState) =>
    setStates((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const save = () => {
    set.mutate({
      nodeId: node.id,
      config: {
        reviewStates: states,
        users: parseList(users),
        commentPhrase: commentPhrase.trim(),
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">PR review submitted</CardTitle>
            <p className="text-xs text-muted-foreground">
              Fires on the GitHub <code className="font-mono">pull_request_review</code> event
              when the action is <code className="font-mono">submitted</code>.
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="text-sm font-medium">Review states</div>
          <div className="flex flex-wrap gap-2">
            {REVIEW_STATES.map((s) => {
              const isActive = states.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggle(s)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs",
                    isActive
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-muted/30 text-muted-foreground hover:border-foreground/40",
                  )}
                >
                  {s}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Empty = match any state. Default is{" "}
            <code className="font-mono">commented + changes_requested</code> — approved /
            dismissed reviews don't need a fix iteration.
          </p>
        </div>

        <ChipField
          label="Users (whitelist)"
          placeholder="opencara[bot], opencara*, alice"
          help="Reviewer logins that may fire this trigger. Globs work (`*` matches anything, `opencara*` matches `opencara[bot]` etc.). Empty = match any user. Default `opencara[bot]` lets pr-review-fix run as the second half of an automated review→fix loop with `pr-review` / `pr-review-multi` — add human logins to opt them in."
          value={users}
          onChange={setUsers}
        />

        <div className="space-y-1">
          <div className="text-sm font-medium">Comment phrase</div>
          <Input
            value={commentPhrase}
            placeholder="@opencara fix"
            onChange={(e) => setCommentPhrase(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Also fires on <code className="font-mono">issue_comment.created</code> when
            the comment body contains this text (case-insensitive). Review-state /
            users filters are skipped on the comment path. <strong>Leave empty</strong>{" "}
            to disable comment-triggering.
          </p>
        </div>

        {set.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {(set.error as Error).message ?? "Save failed"}
          </div>
        )}
        <div className="flex justify-end">
          <Button size="sm" disabled={set.isPending} onClick={save}>
            {set.isPending ? "Saving…" : "Save filters"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── github.projects_v2_item trigger panel ───────────────────── */

const PROJECTS_V2_CONTENT_TYPES = ["Issue", "PullRequest", "DraftIssue"] as const;
type ProjectsV2ContentType = (typeof PROJECTS_V2_CONTENT_TYPES)[number];

interface ProjectsV2ItemTriggerPanelProps {
  scope: EditorScope;
  node: NodeEditorNode;
  onClose: () => void;
}

function ProjectsV2ItemTriggerPanel({
  scope,
  node,
  onClose,
}: ProjectsV2ItemTriggerPanelProps) {
  const cfg = (node.config ?? {}) as {
    projectNumber?: number | null;
    fieldName?: string;
    fromOptions?: string[];
    toOptions?: string[];
    contentTypes?: ProjectsV2ContentType[];
  };
  const initialFieldName = cfg.fieldName ?? "Status";
  const initialFrom = (cfg.fromOptions ?? []).join(", ");
  const initialTo = (cfg.toOptions ?? []).join(", ");
  const initialTypes = useMemo<ProjectsV2ContentType[]>(
    () => cfg.contentTypes ?? ["Issue"],
    [cfg.contentTypes],
  );
  const initialProjectNumber =
    typeof cfg.projectNumber === "number" ? String(cfg.projectNumber) : "";

  const [fieldName, setFieldName] = useState(initialFieldName);
  const [fromOptions, setFromOptions] = useState(initialFrom);
  const [toOptions, setToOptions] = useState(initialTo);
  const [contentTypes, setContentTypes] = useState<ProjectsV2ContentType[]>(initialTypes);
  const [projectNumber, setProjectNumber] = useState(initialProjectNumber);
  const set = useSetNodeConfig(scope);

  useEffect(() => {
    setFieldName(initialFieldName);
    setFromOptions(initialFrom);
    setToOptions(initialTo);
    setContentTypes(initialTypes);
    setProjectNumber(initialProjectNumber);
  }, [initialFieldName, initialFrom, initialTo, initialTypes, initialProjectNumber]);

  const toggleType = (t: ProjectsV2ContentType) =>
    setContentTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const save = () => {
    const trimmedField = fieldName.trim();
    const trimmedNum = projectNumber.trim();
    let parsedNum: number | null = null;
    if (trimmedNum.length > 0) {
      const n = Number(trimmedNum);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return;
      parsedNum = n;
    }
    set.mutate({
      nodeId: node.id,
      config: {
        projectNumber: parsedNum,
        fieldName: trimmedField.length > 0 ? trimmedField : "Status",
        fromOptions: parseList(fromOptions),
        toOptions: parseList(toOptions),
        contentTypes,
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Project status change</CardTitle>
            <p className="text-xs text-muted-foreground">
              Fires on the GitHub <code className="font-mono">projects_v2_item</code> webhook
              when an item moves between options of a single-select field.
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="text-sm font-medium">Content types</div>
          <div className="flex flex-wrap gap-2">
            {PROJECTS_V2_CONTENT_TYPES.map((t) => {
              const isActive = contentTypes.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleType(t)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs",
                    isActive
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-muted/30 text-muted-foreground hover:border-foreground/40",
                  )}
                >
                  {t}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Default <code className="font-mono">Issue</code>. Pick at least one.
          </p>
        </div>

        <ChipField
          label="Field name"
          placeholder="Status"
          help="The single-select field on the project board whose option-change should fire the trigger. Default is `Status` (matches GitHub's default board)."
          value={fieldName}
          onChange={setFieldName}
        />

        <div className="grid gap-3 md:grid-cols-2">
          <ChipField
            label="From options"
            placeholder="* (any)"
            help="Comma-separated option names the item must have moved FROM. Empty = any state."
            value={fromOptions}
            onChange={setFromOptions}
          />
          <ChipField
            label="To options"
            placeholder="* (any)"
            help="Comma-separated option names the item must have moved TO. Empty = any state."
            value={toOptions}
            onChange={setToOptions}
          />
        </div>

        <ChipField
          label="Project number (optional)"
          placeholder="(any board on the org/user)"
          help="Restrict to a specific Projects v2 board number. Leave empty to match any."
          value={projectNumber}
          onChange={setProjectNumber}
        />

        {set.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {(set.error as Error).message ?? "Save failed"}
          </div>
        )}
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={set.isPending || contentTypes.length === 0}
            onClick={save}
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
