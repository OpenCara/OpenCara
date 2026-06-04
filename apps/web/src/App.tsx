import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router";
import { AppShell } from "@/layouts/AppShell";
import { AuthGate } from "@/auth/AuthGate";
import { RouteFallback } from "@/components/RouteFallback";

// Route-level code splitting: each page ships as its own chunk so the initial
// download (login + landing) no longer pays for the whole app. Pages export
// named components, so map the named export onto the `default` shape that
// React.lazy expects. AppShell and AuthGate stay eager — they are part of the
// shell that renders around every authenticated page.
const LoginPage = lazy(() =>
  import("@/pages/LoginPage").then((m) => ({ default: m.LoginPage })),
);
const ActivityPage = lazy(() =>
  import("@/pages/ActivityPage").then((m) => ({ default: m.ActivityPage })),
);
const ProjectsPage = lazy(() =>
  import("@/pages/ProjectsPage").then((m) => ({ default: m.ProjectsPage })),
);
const AddProjectPage = lazy(() =>
  import("@/pages/AddProjectPage").then((m) => ({ default: m.AddProjectPage })),
);
const ProjectDetailPage = lazy(() =>
  import("@/pages/ProjectDetailPage").then((m) => ({
    default: m.ProjectDetailPage,
  })),
);
const ProjectFlowDetailPage = lazy(() =>
  import("@/pages/ProjectFlowDetailPage").then((m) => ({
    default: m.ProjectFlowDetailPage,
  })),
);
const FlowRunDetailPage = lazy(() =>
  import("@/pages/FlowRunDetailPage").then((m) => ({
    default: m.FlowRunDetailPage,
  })),
);
const DevicePairPage = lazy(() =>
  import("@/pages/DevicePairPage").then((m) => ({ default: m.DevicePairPage })),
);
const DevicesPage = lazy(() =>
  import("@/pages/DevicesPage").then((m) => ({ default: m.DevicesPage })),
);
const PromptsPage = lazy(() =>
  import("@/pages/PromptsPage").then((m) => ({ default: m.PromptsPage })),
);
const AgentsPage = lazy(() =>
  import("@/pages/AgentsPage").then((m) => ({ default: m.AgentsPage })),
);
const FlowTemplatesPage = lazy(() =>
  import("@/pages/FlowTemplatesPage").then((m) => ({
    default: m.FlowTemplatesPage,
  })),
);
const FlowTemplateDetailPage = lazy(() =>
  import("@/pages/FlowTemplateDetailPage").then((m) => ({
    default: m.FlowTemplateDetailPage,
  })),
);
const IssueDetailPage = lazy(() =>
  import("@/pages/IssueDetailPage").then((m) => ({
    default: m.IssueDetailPage,
  })),
);

export function App() {
  return (
    // Outer boundary covers routes rendered outside the AppShell (login). The
    // AppShell renders its own inner <Suspense> around <Outlet> so navigating
    // between authenticated pages keeps the nav shell painted.
    <Suspense fallback={<RouteFallback />}>
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
    </Suspense>
  );
}
