import { Routes, Route, Navigate } from "react-router";
import { LoginPage } from "@/pages/LoginPage";
import { AppShell } from "@/layouts/AppShell";
import { AuthGate } from "@/auth/AuthGate";
import { ActivityPage } from "@/pages/ActivityPage";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { AddProjectPage } from "@/pages/AddProjectPage";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";
import { ProjectFlowDetailPage } from "@/pages/ProjectFlowDetailPage";
import { FlowRunDetailPage } from "@/pages/FlowRunDetailPage";
import { DevicePairPage } from "@/pages/DevicePairPage";
import { DevicesPage } from "@/pages/DevicesPage";
import { PromptsPage } from "@/pages/PromptsPage";
import { AgentsPage } from "@/pages/AgentsPage";
import { FlowTemplatesPage } from "@/pages/FlowTemplatesPage";
import { FlowTemplateDetailPage } from "@/pages/FlowTemplateDetailPage";
import { IssueDetailPage } from "@/pages/IssueDetailPage";

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
        {/* `projects/:id/flows` (no slug) is the Flows tab — it falls through
            to the `:tab` route below. The slug route stays for flow detail. */}
        <Route path="projects/:id/flows/:slug" element={<ProjectFlowDetailPage />} />
        <Route path="projects/:id/flow-runs/:runId" element={<FlowRunDetailPage />} />
        <Route path="projects/:id/issues/:number" element={<IssueDetailPage />} />
        {/* Less-specific tab routes go LAST so they don't shadow the above. */}
        <Route path="projects/:id/:tab" element={<ProjectDetailPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="devices/pair" element={<DevicePairPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="flows" element={<FlowTemplatesPage />} />
        <Route path="flows/:slug" element={<FlowTemplateDetailPage />} />
        <Route path="prompts" element={<PromptsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
