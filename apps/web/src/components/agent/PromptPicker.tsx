import { useQuery } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { promptsQuery, useSetIssuePrompt } from "@/lib/queries";

/** Sentinel for the Select's "no explicit prompt — inherit / none" option. */
const NO_PROMPT_VALUE = "__none";

/**
 * Implementation-prompt picker, the prompt-side mirror of {@link AgentPicker}
 * (#158). Reads the current `prompt:<name>` label from the issue and lets the
 * user swap or clear it.
 *
 * When `defaultPromptName` is provided the issue has no per-card override and
 * the card inherits the project-level default implement prompt; the "inherit"
 * option then reads `Default (<name>)` instead of `None`. Picking an explicit
 * prompt writes the `prompt:<name>` label (an override that does not touch the
 * project default); picking the inherit option clears the label.
 *
 * Unlike the agent, the prompt is optional — a flow runs fine with none.
 *
 * `compact` renders a smaller trigger suitable for kanban cards.
 */
export function PromptPicker({
  projectId,
  issueNumber,
  labels,
  compact,
  defaultPromptName,
}: {
  projectId: string;
  issueNumber: number;
  labels: { name: string; color: string }[];
  compact?: boolean;
  defaultPromptName?: string | null;
}) {
  const promptsQ = useQuery(promptsQuery());
  const setPrompt = useSetIssuePrompt(projectId, issueNumber);

  const userPrompts = promptsQ.data?.prompts ?? [];
  const currentLabelName = labels
    .map((l) => l.name)
    .find((n) => n.startsWith("prompt:"));
  const currentPromptName = currentLabelName?.slice("prompt:".length) ?? null;
  const currentPrompt = currentPromptName
    ? userPrompts.find((p) => p.name === currentPromptName)
    : undefined;

  const value = currentPrompt?.id ?? NO_PROMPT_VALUE;
  const inheritLabel = defaultPromptName
    ? `Default (${defaultPromptName})`
    : "None";

  const onSelect = (next: string) => {
    if (next === value) return;
    if (next === NO_PROMPT_VALUE) {
      setPrompt.mutate({ promptId: null, promptName: null });
      return;
    }
    const prompt = userPrompts.find((p) => p.id === next);
    if (!prompt) return;
    setPrompt.mutate({ promptId: prompt.id, promptName: prompt.name });
  };

  if (compact) {
    return (
      <Select
        value={value}
        onValueChange={onSelect}
        disabled={setPrompt.isPending || promptsQ.isLoading}
      >
        <SelectTrigger className="h-6 w-36 text-[10px]">
          <SelectValue placeholder="Prompt" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_PROMPT_VALUE}>{inheritLabel}</SelectItem>
          {userPrompts.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
      <span className="uppercase tracking-wide text-muted-foreground">
        Implementation prompt
      </span>
      <Select
        value={value}
        onValueChange={onSelect}
        disabled={setPrompt.isPending || promptsQ.isLoading}
      >
        <SelectTrigger className="h-8 w-56">
          <SelectValue placeholder="None" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_PROMPT_VALUE}>{inheritLabel}</SelectItem>
          {userPrompts.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {currentPromptName && !currentPrompt && (
        <span
          className="text-amber-600 dark:text-amber-400"
          title={`Issue is labeled prompt:${currentPromptName} but you don't have a prompt named "${currentPromptName}". Pick None to clear or rename your prompt to take ownership.`}
        >
          (foreign: {currentPromptName})
        </span>
      )}
      {setPrompt.error && (
        <span className="text-destructive">
          {setPrompt.error instanceof Error
            ? setPrompt.error.message
            : String(setPrompt.error)}
        </span>
      )}
    </div>
  );
}
