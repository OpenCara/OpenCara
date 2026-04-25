import { NavLink, Outlet } from "react-router";
import { Activity, FolderGit2, Plus, LogOut, Cpu } from "lucide-react";
import { useUser } from "@/auth/AuthContext";
import { useLogout } from "@/lib/queries";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const navItems = [
  { to: "/", label: "Activity", icon: Activity, end: true },
  { to: "/projects", label: "Projects", icon: FolderGit2 },
  { to: "/projects/new", label: "Add project", icon: Plus },
  { to: "/devices", label: "Devices", icon: Cpu },
];

export function AppShell() {
  const user = useUser();
  const logout = useLogout();

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-60 flex-col border-r bg-card">
        <div className="flex h-14 items-center border-b px-4 font-semibold tracking-tight">
          OpenKira
        </div>
        <nav className="flex-1 space-y-1 p-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
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
                {item.label}
              </NavLink>
            );
          })}
        </nav>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex h-14 items-center justify-end border-b bg-card px-4">
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

        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
