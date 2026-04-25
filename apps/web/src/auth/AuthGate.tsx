import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router";
import type { ReactNode } from "react";
import { meQuery } from "@/lib/queries";
import { ApiError } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";

export function AuthGate({ children }: { children: ReactNode }) {
  const me = useQuery(meQuery());

  if (me.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Skeleton className="h-12 w-48" />
      </div>
    );
  }
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to="/login" replace />;
  }
  if (me.error) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-destructive">
        Failed to load session.
      </div>
    );
  }
  return <>{children}</>;
}
