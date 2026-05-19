import { useQuery } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { agentsQuery, useSetIssueAgent } from "@/lib/queries";

/** Sentinel for the Select's "no agent assigned" option. */
const NO_AGENT_VALUE = "__none";

/**
 * Implementation-agent picker. Reads the current `agent:<name>` label from
 * the issue and lets the user swap or clear it.
 *
 * `compact` renders a smaller trigger suitable for kanban card overlays.
 */
export function AgentPicker({
  projectId,
  issueNumber,
  labels,
  compact,
}: {
  projectId: string;
  issueNumber: number;
  labels: { name: string; color: string }[];
  compact?: boolean;
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
        <SelectTrigger className="h-6 w-36 text-[10px]">
          <SelectValue placeholder="Agent" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_AGENT_VALUE}>None</SelectItem>
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
          <SelectItem value={NO_AGENT_VALUE}>None</SelectItem>
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
