import { useSearchParams } from "react-router";
import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function LoginPage() {
  const [params] = useSearchParams();
  const error = params.get("error");

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
        </CardContent>
      </Card>
    </div>
  );
}
