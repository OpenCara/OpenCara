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
