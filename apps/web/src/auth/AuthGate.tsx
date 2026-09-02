import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router";
import type { ReactNode } from "react";
import { meQuery } from "@/lib/queries";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function AuthGate({ children }: { children: ReactNode }) {
  const me = useQuery(meQuery());

  // `isLoading` stays true across the automatic 5xx retries (see meQuery), so a
  // transient pool-pressure 503 shows the loading state, not an error.
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
  // Retries are exhausted but the failure is recoverable (server hiccup / lost
  // connection, not a 401). Offer a manual retry instead of a dead-end screen
  // that forces a full page reload.
  if (me.error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-sm">
        <p className="text-destructive">Couldn’t load your session.</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => me.refetch()}
          disabled={me.isFetching}
        >
          {me.isFetching ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );
  }
  return <>{children}</>;
}
