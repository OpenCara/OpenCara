import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { Github, Link2, Unlink } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  meQuery,
  authProvidersQuery,
  useUnlinkIdentity,
  type LinkedIdentity,
} from "@/lib/queries";
import { ApiError } from "@/lib/api";

/** Azure DevOps mark — not in lucide. */
function AzureDevOpsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z" />
    </svg>
  );
}

/** Human copy for the error codes the link/unlink flows redirect back with. */
function describeError(code: string): string {
  switch (code) {
    case "linked_to_other_user":
      return "That Microsoft account is already linked to a different OpenCara account. Unlink it there first.";
    case "oauth_state_mismatch":
      return "The link request expired before it completed. Please try again.";
    case "session_expired":
      return "Your session expired while linking. Sign in and try again.";
    case "oauth_failed":
      return "Microsoft sign-in failed. Please try again.";
    default:
      return "Linking failed. Please try again.";
  }
}

export function SettingsPage() {
  const [params] = useSearchParams();
  const error = params.get("error");
  const linked = params.get("linked");
  const me = useQuery(meQuery());
  const providers = useQuery(authProvidersQuery());
  const unlink = useUnlinkIdentity();

  const identities = me.data?.identities ?? [];
  const byProvider = new Map<string, LinkedIdentity>(
    identities.map((i) => [i.provider, i]),
  );
  const entraAvailable = providers.data?.providers.entra ?? false;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage the accounts linked to this OpenCara login.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {describeError(error)}
        </div>
      )}
      {linked === "azure" && !error && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">
          Azure DevOps linked. You can now add Azure DevOps repositories from{" "}
          <span className="font-medium">Add project</span>.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Linked accounts</CardTitle>
          <CardDescription>
            Linking adds a sign-in method and lets this account reach that platform's
            repositories. It does not create a second OpenCara account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {me.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <>
              <IdentityRow
                icon={<Github className="size-4" />}
                name="GitHub"
                identity={byProvider.get("github")}
                canUnlink={identities.length > 1}
                onUnlink={() => unlink.mutate("github")}
                busy={unlink.isPending}
              />
              {entraAvailable ? (
                <IdentityRow
                  icon={<AzureDevOpsIcon className="size-4" />}
                  name="Azure DevOps (Microsoft)"
                  identity={byProvider.get("entra")}
                  canUnlink={identities.length > 1}
                  onUnlink={() => unlink.mutate("entra")}
                  onLink={() => {
                    window.location.href = "/auth/azure/link";
                  }}
                  busy={unlink.isPending}
                />
              ) : (
                <div className="rounded-md border border-dashed px-3 py-3 text-sm text-muted-foreground">
                  Azure DevOps isn't configured on this deployment. Set{" "}
                  <code>AZDO_ENTRA_CLIENT_ID</code> and{" "}
                  <code>AZDO_ENTRA_CLIENT_SECRET</code> on the orchestrator to enable it.
                </div>
              )}
            </>
          )}

          {unlink.isError && (
            <div className="text-sm text-destructive">
              {unlink.error instanceof ApiError &&
              typeof (unlink.error.body as { error?: string })?.error === "string"
                ? (unlink.error.body as { error: string }).error
                : "Could not unlink."}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function IdentityRow({
  icon,
  name,
  identity,
  canUnlink,
  onLink,
  onUnlink,
  busy,
}: {
  icon: React.ReactNode;
  name: string;
  identity: LinkedIdentity | undefined;
  canUnlink: boolean;
  onLink?: () => void;
  onUnlink: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-3">
      <div className="flex items-center gap-3">
        {icon}
        <div>
          <div className="text-sm font-medium">{name}</div>
          <div className="text-xs text-muted-foreground">
            {identity ? (identity.login ?? "linked") : "not linked"}
          </div>
        </div>
      </div>
      {identity ? (
        <div className="flex items-center gap-2">
          <Badge variant="secondary">linked</Badge>
          {/* The last identity is the only way back into the account, so it
              can't be removed — the server refuses too. */}
          {canUnlink && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onUnlink}>
              <Unlink className="size-4" />
              Unlink
            </Button>
          )}
        </div>
      ) : onLink ? (
        <Button size="sm" onClick={onLink}>
          <Link2 className="size-4" />
          Link
        </Button>
      ) : null}
    </div>
  );
}
