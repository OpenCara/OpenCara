import { useQuery } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { agentsQuery, useSetIssueAgent } from "@/lib/queries";

/** Sentinel for the Select's "no explicit agent — inherit / none" option. */
const NO_AGENT_VALUE = "__none";

/**
 * Implementation-agent picker. Reads the current `agent:<name>` label from
 * the issue and lets the user swap or clear it.
 *
 * When `defaultAgentName` is provided, the issue has no per-card override and
 * the card inherits the project-level default implement agent (#158). The
 * "inherit" option then reads `Default (<name>)` instead of `None`, and the
 * trigger shows it so the user sees which agent will actually run. Picking an
 * explicit agent writes the `agent:<name>` label (an override that does not
 * touch the project default); picking the inherit option clears the label.
 *
 * `compact` renders a smaller trigger suitable for kanban cards.
 */
export function AgentPicker({
  projectId,
  issueNumber,
  labels,
  compact,
  defaultAgentName,
}: {
  projectId: string;
  issueNumber: number;
  labels: { name: string; color: string }[];
  compact?: boolean;
  defaultAgentName?: string | null;
}) {
  const agentsQ = useQuery(agentsQuery());
  const setAgent = useSetIssueAgent(projectId, issueNumber);

  const userAgents = agentsQ.data?.agents ?? [];
  const currentLabelName = labels
    .map((l) => l.name)
    .find((n) => n.startsWith("agent:"));
  const currentAgentName = currentLabelName?.slice("agent:".length) ?? null;
  const currentAgent = currentAgentName
    ? userAgents.find((a) => a.name === currentAgentName)
    : undefined;

  const value = currentAgent?.id ?? NO_AGENT_VALUE;
  // When no override label is set, surface the inherited project default so
  // the dropdown isn't misleadingly "None" while a default would actually run.
  const inheritLabel = defaultAgentName
    ? `Default (${defaultAgentName})`
    : "None";

  const onSelect = (next: string) => {
    if (next === value) return;
    if (next === NO_AGENT_VALUE) {
      setAgent.mutate({ agentId: null, agentName: null });
      return;
    }
    const agent = userAgents.find((a) => a.id === next);
    if (!agent) return;
    setAgent.mutate({ agentId: agent.id, agentName: agent.name });
  };

  if (compact) {
    return (
      <Select
        value={value}
        onValueChange={onSelect}
        disabled={setAgent.isPending || agentsQ.isLoading}
      >
        <SelectTrigger className="h-6 w-full min-w-0 text-[10px]">
          <SelectValue placeholder="Agent" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_AGENT_VALUE}>{inheritLabel}</SelectItem>
          {userAgents.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
      <span className="uppercase tracking-wide text-muted-foreground">
        Implementation agent
      </span>
      <Select
        value={value}
        onValueChange={onSelect}
        disabled={setAgent.isPending || agentsQ.isLoading}
      >
        <SelectTrigger className="h-8 w-56">
          <SelectValue placeholder="None" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_AGENT_VALUE}>{inheritLabel}</SelectItem>
          {userAgents.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {currentAgentName && !currentAgent && (
        <span
          className="text-amber-600 dark:text-amber-400"
          title={`Issue is labeled agent:${currentAgentName} but you don't have an agent named "${currentAgentName}". Pick None to clear or rename your agent to take ownership.`}
        >
          (foreign: {currentAgentName})
        </span>
      )}
      {setAgent.error && (
        <span className="text-destructive">
          {setAgent.error instanceof Error
            ? setAgent.error.message
            : String(setAgent.error)}
        </span>
      )}
    </div>
  );
}
