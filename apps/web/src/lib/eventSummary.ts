interface PullRequestPayload {
  action?: string;
  pull_request?: { number?: number; title?: string; user?: { login?: string } };
  sender?: { login?: string };
}
interface IssuesPayload {
  action?: string;
  issue?: { number?: number; title?: string; user?: { login?: string } };
  label?: { name?: string };
  sender?: { login?: string };
}
interface PushPayload {
  ref?: string;
  commits?: unknown[];
  pusher?: { name?: string };
}
interface InstallationPayload {
  action?: string;
  installation?: { account?: { login?: string } };
}

export function summarizeEvent(type: string, payload: unknown): string {
  if (!payload || typeof payload !== "object") return type;
  switch (type) {
    case "pull_request": {
      const p = payload as PullRequestPayload;
      const num = p.pull_request?.number;
      const action = p.action ?? "?";
      const who = p.sender?.login ?? p.pull_request?.user?.login ?? "?";
      return `PR #${num} ${action} by @${who}`;
    }
    case "issues": {
      const p = payload as IssuesPayload;
      const num = p.issue?.number;
      const action = p.action ?? "?";
      const label = p.label?.name ? ` (${p.label.name})` : "";
      const who = p.sender?.login ?? p.issue?.user?.login ?? "?";
      return `Issue #${num} ${action}${label} by @${who}`;
    }
    case "push": {
      const p = payload as PushPayload;
      const branch = p.ref?.replace("refs/heads/", "") ?? "?";
      const count = p.commits?.length ?? 0;
      const who = p.pusher?.name ?? "?";
      return `${count} commit${count === 1 ? "" : "s"} pushed to ${branch} by ${who}`;
    }
    case "installation":
    case "installation_repositories": {
      const p = payload as InstallationPayload;
      return `${p.action ?? "?"} on @${p.installation?.account?.login ?? "?"}`;
    }
    default:
      return type;
  }
}
