import { Routes, Route, Navigate } from "react-router";
import { LoginPage } from "@/pages/LoginPage";
import { AppShell } from "@/layouts/AppShell";
import { AuthGate } from "@/auth/AuthGate";
import { ActivityPage } from "@/pages/ActivityPage";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { AddProjectPage } from "@/pages/AddProjectPage";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";
import { ProjectFlowsPage } from "@/pages/ProjectFlowsPage";
import { ProjectFlowDetailPage } from "@/pages/ProjectFlowDetailPage";
import { FlowRunDetailPage } from "@/pages/FlowRunDetailPage";
import { DevicePairPage } from "@/pages/DevicePairPage";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <AuthGate>
            <AppShell />
          </AuthGate>
        }
      >
        <Route index element={<ActivityPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/new" element={<AddProjectPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
        <Route path="projects/:id/:tab" element={<ProjectDetailPage />} />
        <Route path="projects/:id/flows" element={<ProjectFlowsPage />} />
        <Route path="projects/:id/flows/:slug" element={<ProjectFlowDetailPage />} />
        <Route path="projects/:id/flow-runs/:runId" element={<FlowRunDetailPage />} />
        <Route path="devices/pair" element={<DevicePairPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
