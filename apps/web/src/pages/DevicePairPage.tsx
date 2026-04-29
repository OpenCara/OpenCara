import { useState, useEffect } from "react";
import { useSearchParams, Navigate } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useUser } from "@/auth/AuthContext";
import { api, ApiError } from "@/lib/api";

interface PairingInfo {
  code: string;
  status: string;
  expiresAt: string;
  deviceName: string | null;
}

export function DevicePairPage() {
  const [params] = useSearchParams();
  const code = params.get("code") ?? "";
  const user = useUser();
  const [name, setName] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (user && !name) {
      const host = guessHostName();
      setName(`${user.githubLogin}'s ${host}`);
    }
  }, [user, name]);

  const info = useQuery({
    queryKey: ["pairings", code],
    queryFn: () => api.get<PairingInfo>(`/api/devices/pairings/${encodeURIComponent(code)}`),
    enabled: !!code,
    retry: false,
  });

  const confirm = useMutation({
    mutationFn: () =>
      api.post<{ ok: true }>(
        `/api/devices/pairings/${encodeURIComponent(code)}/confirm`,
        { device_name: name },
      ),
    onSuccess: () => setConfirmed(true),
  });

  if (!code) return <Navigate to="/devices" replace />;

  return (
    <div className="mx-auto max-w-md space-y-6 py-8">
      <Card>
        <CardHeader>
          <CardTitle>Pair a new device</CardTitle>
          <CardDescription>
            Confirm that this code came from your terminal.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border bg-muted/30 px-4 py-3 text-center font-mono text-2xl tracking-widest">
            {code}
          </div>

          {info.isLoading && <Skeleton className="h-12 w-full" />}
          {info.error instanceof ApiError && info.error.status === 404 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Pairing not found or already used.
            </div>
          )}
          {info.data && info.data.status !== "pending" && !confirmed && (
            <div className="rounded-md border border-amber-300/40 bg-amber-50/40 px-3 py-2 text-sm">
              Pairing is {info.data.status}. Generate a new code with{" "}
              <code>opencara --force-pair</code>.
            </div>
          )}
          {info.data?.status === "pending" && !confirmed && (
            <>
              <div>
                <Label htmlFor="name">Device name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my laptop"
                />
              </div>
              {confirm.error && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {confirm.error.message}
                </div>
              )}
              <Button
                className="w-full"
                disabled={!name.trim() || confirm.isPending}
                onClick={() => confirm.mutate()}
              >
                {confirm.isPending ? "Confirming…" : "Confirm pairing"}
              </Button>
            </>
          )}
          {confirmed && (
            <div className="rounded-md border border-emerald-300/40 bg-emerald-50/40 px-3 py-3 text-sm">
              Paired. Return to your terminal — the CLI will connect and
              start accepting jobs automatically.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function guessHostName(): string {
  if (typeof navigator === "undefined") return "device";
  if (navigator.platform?.toLowerCase().includes("mac")) return "Mac";
  if (navigator.platform?.toLowerCase().includes("win")) return "PC";
  return "device";
}
