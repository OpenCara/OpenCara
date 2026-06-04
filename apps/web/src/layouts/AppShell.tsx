import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  FolderGit2,
  LogOut,
  Cpu,
  Bot,
  MessageCircle,
  Sparkles,
  Workflow,
} from "lucide-react";
import { useUser } from "@/auth/AuthContext";
import {
  useLogout,
  projectsQuery,
  flowTemplatesQuery,
  agentsQuery,
  devicesQuery,
  promptsQuery,
} from "@/lib/queries";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
// Lazy: ChatPanel drags in highlight.js + react-markdown (~330 KB raw). It is
// only needed once the user opens chat, so keep it out of the initial graph
// (incl. the login/landing path) and mount it on first open (issue #150 #1/#2).
const ChatPanel = lazy(() =>
  import("@/components/chat/ChatPanel").then((m) => ({ default: m.ChatPanel })),
);
import { SelectionToolbar } from "@/components/SelectionToolbar";
import { ChatActionsProvider } from "@/lib/chatActions";
import { RouteFallback } from "@/components/RouteFallback";

interface NavEntry {
  to: string;
  label: string;
  icon: typeof Activity;
  end?: boolean;
}

const topNav: NavEntry[] = [
  { to: "/", label: "Activity", icon: Activity, end: true },
  { to: "/projects", label: "Projects", icon: FolderGit2, end: true },
];
const tailNav: NavEntry[] = [
  { to: "/flows", label: "Flows", icon: Workflow, end: true },
  { to: "/prompts", label: "Prompts", icon: Sparkles, end: true },
  { to: "/agents", label: "Agents", icon: Bot, end: true },
  { to: "/devices", label: "Devices", icon: Cpu, end: true },
];

export function AppShell() {
  const user = useUser();
  const logout = useLogout();
  const location = useLocation();
  const projectsQ = useQuery(projectsQuery());
  const templatesQ = useQuery(flowTemplatesQuery());
  const agentsQ = useQuery(agentsQuery());
  const devicesQ = useQuery(devicesQuery());
  const promptsQ = useQuery(promptsQuery());
  const [chatOpen, setChatOpen] = useState(false);
  // Stays true after the first open so ChatPanel keeps its state across
  // close/reopen — and so its lazy chunk only loads when chat is first used.
  const [chatMounted, setChatMounted] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);

  const onChatWithSelection = useCallback((text: string) => {
    setSelection(text);
    setChatMounted(true);
    setChatOpen(true);
  }, []);

  const onClearSelection = useCallback(() => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  // Clear stale selection when navigating to a different page.
  useEffect(() => {
    setSelection(null);
  }, [location.pathname]);
  const projects = projectsQ.data?.projects ?? [];
  const templates = templatesQ.data?.templates ?? [];
  const agents = agentsQ.data?.agents ?? [];
  // Hide revoked devices in the sidebar — the Devices page itself still shows
  // them for audit reasons, but they're noise in nav.
  const devices = (devicesQ.data?.devices ?? []).filter((d) => !d.revokedAt);
  const allPrompts = promptsQ.data?.prompts ?? [];

  return (
    <ChatActionsProvider>
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-60 flex-col border-r bg-card">
        <div className="flex h-14 items-center border-b px-4 font-semibold tracking-tight">
          OpenCara
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-2">
          {topNav.map((item) => (
            <SidebarLink
              key={item.to}
              to={item.to}
              label={item.label}
              icon={item.icon}
              end={item.end}
            />
          ))}

          {projects.length > 0 && (
            <div className="space-y-0.5 pl-5">
              {projects.map((p) => (
                <NavLink
                  key={p.id}
                  to={`/projects/${p.id}`}
                  end
                  className={({ isActive }) =>
                    cn(
                      "block truncate rounded-md px-2 py-1 text-xs",
                      isActive
                        ? "bg-secondary text-secondary-foreground"
                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                    )
                  }
                  title={`${p.owner}/${p.name}`}
                >
                  {p.owner}/{p.name}
                </NavLink>
              ))}
            </div>
          )}

          {tailNav.map((item) => (
            <div key={item.to}>
              <SidebarLink
                to={item.to}
                label={item.label}
                icon={item.icon}
                end={item.end}
              />
              {item.to === "/agents" && agents.length > 0 && (
                <NestedList>
                  {agents.map((a) => (
                    <HashItem
                      key={a.id}
                      to={`/agents#agent-${a.id}`}
                      title={a.name}
                      label={a.name}
                    />
                  ))}
                </NestedList>
              )}
              {item.to === "/prompts" && allPrompts.length > 0 && (
                <NestedList>
                  {allPrompts.map((p) => (
                    <HashItem
                      key={p.id}
                      to={`/prompts#prompt-${p.id}`}
                      title={
                        p.labels.length > 0
                          ? `${p.name} · ${p.labels.join(", ")}`
                          : p.name
                      }
                      label={p.name}
                    />
                  ))}
                </NestedList>
              )}
              {item.to === "/devices" && devices.length > 0 && (
                <NestedList>
                  {devices.map((d) => (
                    <NestedItem
                      key={d.id}
                      to="/devices"
                      title={d.name}
                      label={
                        <span className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              "size-1.5 rounded-full",
                              d.online ? "bg-emerald-500" : "bg-muted-foreground/40",
                            )}
                          />
                          {d.name}
                        </span>
                      }
                    />
                  ))}
                </NestedList>
              )}
              {item.to === "/flows" && templates.length > 0 && (
                <NestedList>
                  {templates.map((t) => (
                    <NestedItem
                      key={t.slug}
                      to={`/flows/${t.slug}`}
                      title={t.name}
                      label={t.name}
                    />
                  ))}
                </NestedList>
              )}
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-end gap-3 border-b bg-card px-4">
          <Button
            size="sm"
            variant={chatOpen ? "secondary" : "ghost"}
            onClick={() => {
              setChatMounted(true);
              setChatOpen((prev) => {
                if (prev) setSelection(null);
                return !prev;
              });
            }}
            title="Open chat assistant"
          >
            <MessageCircle className="size-4" />
            <span className="hidden md:inline">Chat</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger className="outline-none">
              <Avatar className="size-8 cursor-pointer">
                <AvatarImage src={user?.avatarUrl ?? undefined} />
                <AvatarFallback>
                  {user?.githubLogin?.[0]?.toUpperCase() ?? "?"}
                </AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <div className="px-2 py-1.5 text-sm">
                <div className="font-medium">{user?.name ?? user?.githubLogin}</div>
                <div className="text-xs text-muted-foreground">@{user?.githubLogin}</div>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  logout.mutate(undefined, {
                    onSuccess: () => {
                      window.location.href = "/login";
                    },
                  });
                }}
              >
                <LogOut className="mr-2 size-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto p-6">
          {/* Inner boundary so a lazily-loaded page chunk suspends here,
              keeping the surrounding nav shell painted during the fetch. */}
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      <SelectionToolbar
        containerRef={mainRef}
        onChatWithSelection={onChatWithSelection}
      />
      {chatMounted && (
        <Suspense fallback={null}>
          <ChatPanel
            open={chatOpen}
            onClose={() => {
              setChatOpen(false);
              setSelection(null);
            }}
            selection={selection}
            onClearSelection={onClearSelection}
          />
        </Suspense>
      )}
    </div>
    </ChatActionsProvider>
  );
}

interface SidebarLinkProps {
  to: string;
  label: string;
  icon: typeof Activity;
  end?: boolean;
}

function SidebarLink({ to, label, icon: Icon, end }: SidebarLinkProps) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium",
          isActive
            ? "bg-secondary text-secondary-foreground"
            : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
        )
      }
    >
      <Icon className="size-4" />
      {label}
    </NavLink>
  );
}

function NestedList({ children }: { children: ReactNode }) {
  return <div className="space-y-0.5 pl-5">{children}</div>;
}

function NestedItem({
  to,
  label,
  title,
  end,
}: {
  to: string;
  label: ReactNode;
  title?: string;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={title}
      className={({ isActive }) =>
        cn(
          "block truncate rounded-md px-2 py-1 text-xs",
          isActive
            ? "bg-secondary text-secondary-foreground"
            : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
        )
      }
    >
      {label}
    </NavLink>
  );
}

/**
 * Like NestedItem but matches the URL hash as well. NavLink's isActive only
 * looks at pathname, so two siblings pointing at /agents#agent-A vs
 * /agents#agent-B would both highlight when on /agents. This variant only
 * highlights when the *full* path+hash matches.
 */
function HashItem({
  to,
  label,
  title,
}: {
  to: string;
  label: ReactNode;
  title?: string;
}) {
  const location = useLocation();
  const [path, hash] = to.split("#");
  const fullCurrent = `${location.pathname}${location.hash}`;
  const isActive = fullCurrent === to || (location.pathname === path && location.hash === `#${hash}`);
  return (
    <NavLink
      to={to}
      title={title}
      className={cn(
        "block truncate rounded-md px-2 py-1 text-xs",
        isActive
          ? "bg-secondary text-secondary-foreground"
          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
      )}
    >
      {label}
    </NavLink>
  );
}
