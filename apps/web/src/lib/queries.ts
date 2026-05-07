import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export interface User {
  id: string;
  githubLogin: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
}

export interface ProjectListItem {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string | null;
  private: boolean;
  addedAt: string;
  removedAt: string | null;
  installationId: string;
  installationAccountLogin: string;
  installationAccountType: "User" | "Organization";
  installationSuspendedAt: string | null;
  lastEventAt: string | null;
  recentRunsCount: number;
}

export interface InstallationSummary {
  id: string;
  githubInstallationId: number;
  accountType: "User" | "Organization";
  accountLogin: string;
  accountId: number;
  suspendedAt: string | null;
}

export interface AvailableRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export interface ProjectEvent {
  id: string;
  type: string;
  receivedAt: string;
  deliveryId: string | null;
  payload: unknown;
}

export interface ProjectRun {
  id: string;
  status: string;
  hostId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
}

export interface ActivityItem {
  kind: "event" | "run";
  id: string;
  ts: string;
  type: string;
  project_id: string | null;
  payload: unknown;
}

export interface FlowGraph {
  nodes: Array<{
    id: string;
    kind: string;
    position: { x: number; y: number };
    config?: Record<string, unknown>;
  }>;
  edges: Array<{ id: string; source: string; target: string }>;
  description?: string;
}
export interface FlowSummary {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  graphJson: FlowGraph;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface FlowRunSummary {
  id: string;
  flowId: string;
  projectId: string;
  triggerEventId: string | null;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  error: string | null;
}
export interface FlowRunStep {
  id: string;
  flowRunId: string;
  nodeId: string;
  nodeKind: string;
  idx: number;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  inputJson: unknown;
  outputJson: unknown;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}
export interface AgentRunRow {
  id: string;
  status: "queued" | "assigned" | "running" | "succeeded" | "failed" | "cancelled";
  hostId: string | null;
  flowRunStepId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
}

export const meQuery = () => ({
  queryKey: ["me"] as const,
  queryFn: () => api.get<{ user: User }>("/api/me"),
});

export const projectsQuery = () => ({
  queryKey: ["projects"] as const,
  queryFn: () => api.get<{ projects: ProjectListItem[] }>("/api/projects"),
});

export const projectQuery = (id: string) => ({
  queryKey: ["projects", id] as const,
  queryFn: () =>
    api.get<{
      project: ProjectListItem & { removedAt: string | null };
      installation: InstallationSummary;
    }>(`/api/projects/${id}`),
});

export const projectEventsQuery = (id: string) => ({
  queryKey: ["projects", id, "events"] as const,
  queryFn: () => api.get<{ events: ProjectEvent[] }>(`/api/projects/${id}/events`),
});

export interface IssueLabel {
  name: string;
  color: string;
}
export interface IssueAssignee {
  login: string;
  id: number;
}
export interface ProjectIssue {
  id: string;
  number: number;
  title: string;
  state: string;
  stateReason: string | null;
  labels: IssueLabel[];
  assignees: IssueAssignee[];
  authorLogin: string | null;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export const projectIssuesQuery = (
  id: string,
  filters?: { state?: "open" | "closed" | "all"; label?: string | null },
) => {
  const params = new URLSearchParams();
  if (filters?.state && filters.state !== "all") params.set("state", filters.state);
  if (filters?.label) params.set("label", filters.label);
  const qs = params.toString();
  return {
    queryKey: ["projects", id, "issues", filters?.state ?? "all", filters?.label ?? ""] as const,
    queryFn: () =>
      api.get<{ issues: ProjectIssue[] }>(
        `/api/projects/${id}/issues${qs ? `?${qs}` : ""}`,
      ),
  };
};

export function useSyncProjectIssues(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; inserted: number; updated: number; skipped: number }>(
        `/api/projects/${projectId}/issues/sync`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects", projectId, "issues"] });
    },
  });
}

export interface ProjectIssueDetail extends ProjectIssue {
  bodyMd: string | null;
  draftBodyMd: string | null;
  draftUpdatedAt: string | null;
}

export const projectIssueDetailQuery = (projectId: string, issueNumber: number) => ({
  queryKey: ["projects", projectId, "issues", issueNumber] as const,
  queryFn: () =>
    api.get<{ issue: ProjectIssueDetail }>(
      `/api/projects/${projectId}/issues/${issueNumber}`,
    ),
});

export function useSaveIssueBody(projectId: string, issueNumber: number) {
  const qc = useQueryClient();
  return useMutation({
    // No body argument — the server reads issues.draftBodyMd. (Pass an
    // explicit string only if a caller wants to bypass the draft, e.g. for
    // future revert flows.)
    mutationFn: (bodyMd?: string) =>
      api.patch<{ issue: ProjectIssueDetail }>(
        `/api/projects/${projectId}/issues/${issueNumber}/body`,
        bodyMd === undefined ? {} : { bodyMd },
      ),
    onSuccess: (data) => {
      qc.setQueryData(
        ["projects", projectId, "issues", issueNumber] as const,
        data,
      );
      qc.invalidateQueries({ queryKey: ["projects", projectId, "issues"] });
    },
  });
}

/**
 * Set or clear the implementation-agent label on an issue.
 *
 * Pass an `agentId` from the user's `agentsQuery` to assign; pass `null` to
 * remove all `agent:*` labels. The server resolves the id to the agent's
 * name and writes label `agent:<name>` to GitHub (auto-creating the label
 * if missing). The existing issue-implement flow already routes to this
 * label when it dispatches.
 *
 * Optimistic update: rewrite the issue's `labels` array locally before the
 * round-trip, roll back on error, refetch on settle so out-of-band label
 * edits also reconcile.
 */
export function useSetIssueAgent(projectId: string, issueNumber: number) {
  const qc = useQueryClient();
  const detailKey = ["projects", projectId, "issues", issueNumber] as const;
  return useMutation({
    mutationFn: (vars: { agentId: string | null; agentName: string | null }) =>
      api.patch<{ issue: ProjectIssueDetail }>(
        `/api/projects/${projectId}/issues/${issueNumber}/agent`,
        { agentId: vars.agentId },
      ),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: detailKey });
      const prev = qc.getQueryData<{ issue: ProjectIssueDetail }>(detailKey);
      if (prev) {
        const filtered = prev.issue.labels.filter(
          (l) => !l.name.startsWith("agent:"),
        );
        // Reuse an existing label's color if the user previously had one
        // and is just renaming. Otherwise leave color empty and let the
        // server reconcile — the hardcoded fallback would briefly show
        // the wrong color on labels customised on GitHub side.
        const priorAgentColor = prev.issue.labels.find((l) =>
          l.name.startsWith("agent:"),
        )?.color;
        const next = vars.agentName
          ? [
              ...filtered,
              {
                name: `agent:${vars.agentName}`,
                color: priorAgentColor ?? "",
              },
            ]
          : filtered;
        qc.setQueryData(detailKey, {
          ...prev,
          issue: { ...prev.issue, labels: next },
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(detailKey, ctx.prev);
    },
    // Success-only invalidation: a failed mutation already rolled back
    // via onError; refetching after failure is wasted work.
    onSuccess: (data) => {
      qc.setQueryData(detailKey, data);
      // Predicate-based invalidate: refresh the issues *list* but not the
      // detail (which we just wrote authoritatively above). Without this,
      // the wider ["projects", id, "issues"] key match cascades into the
      // detail and immediately undoes our setQueryData.
      qc.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey;
          return (
            Array.isArray(k) &&
            k[0] === "projects" &&
            k[1] === projectId &&
            k[2] === "issues" &&
            k.length === 3
          );
        },
      });
      qc.invalidateQueries({
        queryKey: ["projects", projectId, "kanban"],
        exact: true,
      });
    },
  });
}

export function useSetIssueDraft(projectId: string, issueNumber: number) {
  const qc = useQueryClient();
  return useMutation({
    // Pass null to discard the draft.
    mutationFn: (bodyMd: string | null) =>
      api.patch<{ issue: ProjectIssueDetail }>(
        `/api/projects/${projectId}/issues/${issueNumber}/draft`,
        { bodyMd },
      ),
    onSuccess: (data) => {
      qc.setQueryData(
        ["projects", projectId, "issues", issueNumber] as const,
        data,
      );
    },
  });
}

export const projectRunsQuery = (id: string) => ({
  queryKey: ["projects", id, "runs"] as const,
  queryFn: () => api.get<{ runs: ProjectRun[] }>(`/api/projects/${id}/runs`),
});

export const projectFlowRunsQuery = (id: string) => ({
  queryKey: ["projects", id, "flow-runs"] as const,
  queryFn: () =>
    api.get<{ runs: FlowRunSummary[] }>(`/api/projects/${id}/flow-runs`),
});

export interface FlowTemplateSummary {
  slug: string;
  name: string;
  description: string;
  nodeCount: number;
  edgeCount: number;
}
export interface FlowTemplateDetail extends FlowTemplateSummary {
  graphJson: FlowGraph;
}

export interface TemplateNodeSetting {
  id: string;
  userId: string;
  templateSlug: string;
  nodeId: string;
  promptId: string | null;
  agentId: string | null;
  label: string | null;
  updatedAt: string;
}

export const flowTemplatesQuery = () => ({
  queryKey: ["flow-templates"] as const,
  queryFn: () =>
    api.get<{ templates: FlowTemplateSummary[] }>("/api/flow-templates"),
});

export const flowTemplateDetailQuery = (slug: string) => ({
  queryKey: ["flow-templates", slug] as const,
  queryFn: () =>
    api.get<{
      template: FlowTemplateDetail;
      hasDraft: boolean;
      customizedAt: string | null;
      settings: TemplateNodeSetting[];
    }>(`/api/flow-templates/${slug}`),
});

export const installationsQuery = () => ({
  queryKey: ["installations"] as const,
  queryFn: () => api.get<{ installations: InstallationSummary[] }>("/api/installations"),
});

export const availableReposQuery = (installationId: string) => ({
  queryKey: ["installations", installationId, "available-repos"] as const,
  queryFn: () =>
    api.get<{ available: AvailableRepo[] }>(
      `/api/installations/${installationId}/available-repos`,
    ),
});

export const activityQuery = () => ({
  queryKey: ["activity"] as const,
  queryFn: () => api.get<{ activity: ActivityItem[] }>("/api/activity"),
});

export const projectFlowsQuery = (projectId: string) => ({
  queryKey: ["projects", projectId, "flows"] as const,
  queryFn: () =>
    api.get<{ flows: FlowSummary[] }>(`/api/projects/${projectId}/flows`),
});

export const flowDetailQuery = (projectId: string, slug: string) => ({
  queryKey: ["projects", projectId, "flows", slug] as const,
  queryFn: () =>
    api.get<{ flow: FlowSummary; runs: FlowRunSummary[] }>(
      `/api/projects/${projectId}/flows/${slug}`,
    ),
});

export const flowRunDetailQuery = (runId: string) => ({
  queryKey: ["flow-runs", runId] as const,
  queryFn: () =>
    api.get<{ run: FlowRunSummary; steps: FlowRunStep[]; agentRuns: AgentRunRow[] }>(
      `/api/flow-runs/${runId}`,
    ),
});

export interface PromptRow {
  id: string;
  userId: string;
  name: string;
  body: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export const promptsQuery = () => ({
  queryKey: ["prompts"] as const,
  queryFn: () => api.get<{ prompts: PromptRow[] }>("/api/prompts"),
});

export interface FlowNodeSetting {
  id: string;
  flowId: string;
  nodeId: string;
  promptId: string | null;
  agentId: string | null;
  label: string | null;
  updatedAt: string;
}

export type AgentKind = "claude" | "codex" | "opencode" | "pi" | "custom";

export interface AgentRow {
  id: string;
  userId: string;
  name: string;
  /** Selects per-kind adapter at dispatch time. `custom` = legacy
   *  opaque-subprocess behaviour (no conversation resume across runs). */
  kind: AgentKind;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  /** Pin to a specific agent_host (device). null = "any idle device". */
  hostId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const agentsQuery = () => ({
  queryKey: ["agents"] as const,
  queryFn: () => api.get<{ agents: AgentRow[] }>("/api/agents"),
});

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      name: string;
      /** Selects per-kind adapter (claude/codex/opencode/pi) or `custom`
       *  for the legacy free-form command. Defaults to `custom` server-side. */
      kind?: AgentKind;
      /** For kind=custom: full shell-style command incl. args. Server tokenizes. */
      command?: string;
      /** For kind!=custom: extra args appended to the adapter's base args
       *  (e.g. `--provider kimi-coding --model kimi-k2-thinking` for pi).
       *  Free-form string — server tokenizes the same way as Command. */
      extraArgs?: string;
      env?: Record<string, string>;
      cwd?: string | null;
      /** Specific device id; null/undefined = "any idle device". */
      hostId?: string | null;
    }) => api.post<{ agent: AgentRow }>("/api/agents", vars),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Partial<Omit<AgentRow, "id" | "userId" | "createdAt" | "updatedAt">> }) =>
      api.patch<{ agent: AgentRow }>(`/api/agents/${vars.id}`, vars.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/agents/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

export function useTestAgent() {
  return useMutation({
    mutationFn: (vars: {
      id: string;
      prompt: string;
      /**
       * Pin this test run to a specific device. Pass `null` to explicitly
       * target "any idle device" (overriding the agent's saved pin).
       * Omitting `hostId` falls back to the agent's saved pin.
       */
      hostId?: string | null;
    }) => {
      const body: Record<string, unknown> = { prompt: vars.prompt };
      if ("hostId" in vars) body.hostId = vars.hostId;
      return api.post<{ agentRunId: string }>(`/api/agents/${vars.id}/test`, body);
    },
  });
}

export const flowNodeSettingsQuery = (projectId: string, flowId: string) => ({
  queryKey: ["projects", projectId, "flows", flowId, "node-settings"] as const,
  queryFn: () =>
    api.get<{ settings: FlowNodeSetting[] }>(
      `/api/projects/${projectId}/flows/${flowId}/node-settings`,
    ),
});

export function useCreatePrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; body: string; labels?: string[] }) =>
      api.post<{ prompt: PromptRow }>("/api/prompts", vars),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["prompts"] }),
  });
}

export function useUpdatePrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      name?: string;
      body?: string;
      labels?: string[];
    }) =>
      api.patch<{ prompt: PromptRow }>(`/api/prompts/${vars.id}`, {
        name: vars.name,
        body: vars.body,
        labels: vars.labels,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["prompts"] }),
  });
}

export function useDeletePrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/prompts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["prompts"] }),
  });
}

export function useSetFlowEnabled(projectId: string, slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch<{ flow: FlowSummary }>(
        `/api/projects/${projectId}/flows/${slug}`,
        { enabled },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects", projectId, "flows", slug] });
      qc.invalidateQueries({ queryKey: ["projects", projectId, "flows"] });
    },
  });
}

export function useTriggerFlow(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      api.post<{ flowRunId: string }>(
        `/api/projects/${projectId}/flows/${slug}/trigger`,
      ),
    onSuccess: (_data, slug) => {
      qc.invalidateQueries({ queryKey: ["projects", projectId, "flows", slug] });
    },
  });
}

export function useRerunFlow(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { runId: string; fromStepId?: string }) =>
      api.post<{ flowRunId: string }>(
        `/api/flow-runs/${vars.runId}/rerun`,
        vars.fromStepId ? { fromStepId: vars.fromStepId } : {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects", projectId, "flow-runs"] });
    },
  });
}

export interface DeviceSystemInfo {
  os: string;
  release: string;
  arch: string;
  hostname: string;
  cpu: { model: string; cores: number; speedMhz: number };
  memory: { totalBytes: number; freeBytes: number };
  disk?: { path: string; totalBytes: number; freeBytes: number };
  ipAddrs: string[];
  uptimeSec: number;
}

export interface DeviceRow {
  id: string;
  name: string;
  platform: string | null;
  version: string | null;
  online: boolean;
  lastConnectedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  systemInfo: DeviceSystemInfo | null;
  systemInfoUpdatedAt: string | null;
}

export const devicesQuery = () => ({
  queryKey: ["devices"] as const,
  queryFn: () => api.get<{ devices: DeviceRow[] }>("/api/devices"),
});

export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<void>(`/api/devices/${id}/revoke`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["devices"] }),
  });
}

export function useAddProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { installationId: string; githubRepoId: number }) =>
      api.post<{ project: { id: string } }>(
        `/api/installations/${vars.installationId}/projects`,
        { githubRepoId: vars.githubRepoId },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["installations"] });
    },
  });
}

export function useRemoveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/projects/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

// ---- Kanban (GitHub Projects v2 mirror) ----

export interface DiscoveredProjectV2 {
  nodeId: string;
  number: number;
  title: string;
  ownerLogin: string;
  ownerType: "Organization" | "User";
}

export interface KanbanStatusOption {
  optionId: string;
  name: string;
  color: string;
  position: number;
}

export interface KanbanLink {
  id: string;
  projectId: string;
  githubProjectNodeId: string;
  githubProjectNumber: number;
  githubProjectOwner: string;
  githubProjectOwnerType: "Organization" | "User";
  githubProjectTitle: string;
  statusFieldNodeId: string;
  statusOptions: KanbanStatusOption[];
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanItem {
  id: string;
  projectV2LinkId: string;
  githubItemNodeId: string;
  kind: "issue" | "pull_request" | "draft";
  contentNodeId: string | null;
  contentNumber: number | null;
  contentTitle: string;
  contentUrl: string | null;
  contentState: string | null;
  statusOptionId: string | null;
  isArchived: boolean;
  assignees: { login: string; id: number }[];
  labels: { name: string; color: string }[];
  updatedAt: string;
}

export interface KanbanBoardData {
  link: KanbanLink | null;
  columns: KanbanStatusOption[];
  items: KanbanItem[];
  /**
   * Repo identity of *this* opencara project. The Kanban board can pull in
   * items from any repo on a multi-repo Projects v2 board, so the UI uses
   * this to decide whether an item belongs to our project's repo (and is
   * thus reachable via the in-app issue route).
   */
  projectRepo: { owner: string; name: string } | null;
}

export const kanbanQuery = (projectId: string) => ({
  queryKey: ["projects", projectId, "kanban"] as const,
  queryFn: () =>
    api.get<KanbanBoardData>(`/api/projects/${projectId}/kanban`),
});

export const kanbanProjectsQuery = (projectId: string) => ({
  queryKey: ["projects", projectId, "kanban", "available"] as const,
  queryFn: () =>
    api.get<{ projects: DiscoveredProjectV2[] }>(
      `/api/projects/${projectId}/kanban/projects`,
    ),
});

export function useLinkKanban(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectNodeId: string) =>
      api.put<{ link: KanbanLink }>(
        `/api/projects/${projectId}/kanban/link`,
        { projectNodeId },
      ),
    onSuccess: () => {
      // exact:true keeps the discovery list cached across link/unlink/refresh.
      qc.invalidateQueries({
        queryKey: ["projects", projectId, "kanban"],
        exact: true,
      });
    },
  });
}

export function useUnlinkKanban(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.delete<void>(`/api/projects/${projectId}/kanban/link`),
    onSuccess: () => {
      // exact:true keeps the discovery list cached across link/unlink/refresh.
      qc.invalidateQueries({
        queryKey: ["projects", projectId, "kanban"],
        exact: true,
      });
    },
  });
}

export function useRefreshKanban(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ link: KanbanLink; itemCount: number }>(
        `/api/projects/${projectId}/kanban/refresh`,
      ),
    onSuccess: () => {
      // exact:true keeps the discovery list cached across link/unlink/refresh.
      qc.invalidateQueries({
        queryKey: ["projects", projectId, "kanban"],
        exact: true,
      });
    },
  });
}

/**
 * Subscribe to /api/projects/:id/kanban/stream while mounted. Each `snapshot`
 * SSE event replaces the kanbanQuery cache directly — no extra refetch — so
 * webhook + cross-tab updates land immediately. EventSource auto-reconnects
 * on transient errors. The matching enabled-on flag falls back to true; pass
 * false to skip subscription (e.g. while the picker is showing).
 */
export function useKanbanStream(
  projectId: string,
  enabled: boolean = true,
): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource(
      `/api/projects/${projectId}/kanban/stream`,
      { withCredentials: true },
    );
    const onSnapshot = (e: MessageEvent) => {
      try {
        const snap = JSON.parse(e.data) as KanbanBoardData;
        qc.setQueryData<KanbanBoardData>(
          ["projects", projectId, "kanban"],
          snap,
        );
      } catch (err) {
        console.error("[kanban-sse] parse failed", err);
      }
    };
    const onPing = () => undefined;
    es.addEventListener("snapshot", onSnapshot);
    es.addEventListener("ping", onPing);
    return () => {
      es.removeEventListener("snapshot", onSnapshot);
      es.removeEventListener("ping", onPing);
      es.close();
    };
  }, [projectId, enabled, qc]);
}

export function useSetItemStatus(projectId: string) {
  const qc = useQueryClient();
  const queryKey = ["projects", projectId, "kanban"] as const;
  return useMutation({
    mutationFn: (vars: { itemNodeId: string; statusOptionId: string | null }) =>
      api.patch<{ item: KanbanItem }>(
        `/api/projects/${projectId}/kanban/items/${encodeURIComponent(
          vars.itemNodeId,
        )}`,
        { statusOptionId: vars.statusOptionId },
      ),
    // Optimistic update: rewrite the matching item's statusOptionId in the
    // cached board snapshot so the card jumps to the new column the moment
    // the user drops it. If the PATCH fails, restore the snapshot.
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey, exact: true });
      const prev = qc.getQueryData<KanbanBoardData>(queryKey);
      if (prev) {
        qc.setQueryData<KanbanBoardData>(queryKey, {
          ...prev,
          items: prev.items.map((it) =>
            it.githubItemNodeId === vars.itemNodeId
              ? { ...it, statusOptionId: vars.statusOptionId }
              : it,
          ),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev);
    },
    onSettled: () => {
      // Webhook is authoritative — refetch so any concurrent change made by
      // someone else on GitHub also reconciles.
      qc.invalidateQueries({ queryKey, exact: true });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>("/auth/logout"),
    onSuccess: () => qc.clear(),
  });
}

export { useQuery, useMutation };
