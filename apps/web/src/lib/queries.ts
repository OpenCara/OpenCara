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

export const projectRunsQuery = (id: string) => ({
  queryKey: ["projects", id, "runs"] as const,
  queryFn: () => api.get<{ runs: ProjectRun[] }>(`/api/projects/${id}/runs`),
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
  projectId: string;
  name: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlowNodeSetting {
  id: string;
  flowId: string;
  nodeId: string;
  promptId: string | null;
  agentId: string | null;
  updatedAt: string;
}

export interface AgentRow {
  id: string;
  userId: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  runOn: "any" | "local" | "device";
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
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string | null;
      runOn?: "any" | "local" | "device";
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

export const promptsQuery = (projectId: string) => ({
  queryKey: ["projects", projectId, "prompts"] as const,
  queryFn: () =>
    api.get<{ prompts: PromptRow[] }>(`/api/projects/${projectId}/prompts`),
});

export const flowNodeSettingsQuery = (projectId: string, flowId: string) => ({
  queryKey: ["projects", projectId, "flows", flowId, "node-settings"] as const,
  queryFn: () =>
    api.get<{ settings: FlowNodeSetting[] }>(
      `/api/projects/${projectId}/flows/${flowId}/node-settings`,
    ),
});

export function useCreatePrompt(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; body: string }) =>
      api.post<{ prompt: PromptRow }>(`/api/projects/${projectId}/prompts`, vars),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["projects", projectId, "prompts"] }),
  });
}

export function useUpdatePrompt(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; name?: string; body?: string }) =>
      api.patch<{ prompt: PromptRow }>(`/api/prompts/${vars.id}`, {
        name: vars.name,
        body: vars.body,
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["projects", projectId, "prompts"] }),
  });
}

export function useDeletePrompt(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/prompts/${id}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["projects", projectId, "prompts"] }),
  });
}

export function useSetFlowNodeSettings(projectId: string, flowId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      nodeId: string;
      promptId?: string | null;
      agentId?: string | null;
    }) => {
      const body: Record<string, string | null> = {};
      if (vars.promptId !== undefined) body.promptId = vars.promptId;
      if (vars.agentId !== undefined) body.agentId = vars.agentId;
      return api.put<{ setting: FlowNodeSetting }>(
        `/api/projects/${projectId}/flows/${flowId}/nodes/${vars.nodeId}/settings`,
        body,
      );
    },
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["projects", projectId, "flows", flowId, "node-settings"],
      }),
  });
}

/** @deprecated use useSetFlowNodeSettings */
export const useSetFlowNodePrompt = useSetFlowNodeSettings;

export interface DeviceRow {
  id: string;
  name: string;
  platform: string | null;
  version: string | null;
  online: boolean;
  lastConnectedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
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

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>("/auth/logout"),
    onSuccess: () => qc.clear(),
  });
}

export { useQuery, useMutation };
