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
