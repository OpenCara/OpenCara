import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface AuthProviders {
  github: boolean;
  entra: boolean;
}

/** Azure DevOps' logo isn't in lucide; this is the Azure DevOps mark. */
function AzureDevOpsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z" />
    </svg>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const error = params.get("error");
  // Defaults to GitHub-only so the primary button renders immediately rather
  // than flashing in after the probe resolves.
  const [providers, setProviders] = useState<AuthProviders>({
    github: true,
    entra: false,
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/providers")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { providers?: AuthProviders } | null) => {
        if (!cancelled && data?.providers) setProviders(data.providers);
      })
      .catch(() => {
        // Probe failure just means we keep the GitHub-only default — no need
        // to block sign-in on it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl tracking-tight">OpenCara</CardTitle>
          <CardDescription>Sign in to manage your projects</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error === "oauth_state_mismatch"
                ? "Login state expired — please try again."
                : "Sign-in failed. Please try again."}
            </div>
          )}
          <Button
            className="w-full"
            onClick={() => {
              window.location.href = "/auth/github/login";
            }}
          >
            <Github className="size-4" />
            Sign in with GitHub
          </Button>
          {providers.entra && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                window.location.href = "/auth/azure/login";
              }}
            >
              <AzureDevOpsIcon className="size-4" />
              Sign in with Microsoft
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
