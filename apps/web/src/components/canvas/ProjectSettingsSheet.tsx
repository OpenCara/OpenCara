import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Settings } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  agentsQuery,
  projectFlowsQuery,
  promptsQuery,
  useSetProjectDefaultImplementAgent,
  useSetProjectDefaultImplementFlow,
  useSetProjectDefaultImplementPrompt,
  useSetProjectInstructionsFile,
} from "@/lib/queries";

/**
 * Project settings, surfaced behind the header gear icon. Holds the two
 * editable knobs that used to live on the (now-removed) Overview tab:
 * the default implement flow and the agent instructions file. Read-only
 * repo metadata is shown inline in the header instead — see #140.
 */
export function ProjectSettingsSheet({
  projectId,
  defaultImplementFlowId,
  defaultImplementAgentId,
  defaultImplementPromptId,
  instructionsFile,
}: {
  projectId: string;
  defaultImplementFlowId: string | null;
  defaultImplementAgentId: string | null;
  defaultImplementPromptId: string | null;
  instructionsFile: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Project settings"
          aria-label="Project settings"
        >
          <Settings className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription>
            Defaults applied when agents run against this project.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6">
          <DefaultImplementFlowSection
            projectId={projectId}
            currentFlowId={defaultImplementFlowId}
          />
          <DefaultImplementAgentSection
            projectId={projectId}
            currentAgentId={defaultImplementAgentId}
          />
          <DefaultImplementPromptSection
            projectId={projectId}
            currentPromptId={defaultImplementPromptId}
          />
          <InstructionsFileSection
            projectId={projectId}
            current={instructionsFile}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

const NO_FLOW_VALUE = "__none";

function DefaultImplementFlowSection({
  projectId,
  currentFlowId,
}: {
  projectId: string;
  currentFlowId: string | null;
}) {
  const flowsQ = useQuery(projectFlowsQuery(projectId));
  const setDefault = useSetProjectDefaultImplementFlow(projectId);
  const flows = flowsQ.data?.flows ?? [];
  // Show the currently-selected flow even if it was later disabled, so the
  // user sees it in the dropdown and can explicitly change or clear it.
  const enabledOrCurrent = flows.filter((f) => f.enabled || f.id === currentFlowId);
  const value = currentFlowId ?? NO_FLOW_VALUE;

  const onSelect = (next: string) => {
    if (next === value) return;
    setDefault.mutate(next === NO_FLOW_VALUE ? null : next);
  };

  return (
    <section className="space-y-2 text-sm">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">
        Implement flow
      </Label>
      <p className="text-xs text-muted-foreground">
        Default flow triggered by the kanban card Start button. Only enabled
        flows are listed.
      </p>
      <Select
        value={value}
        onValueChange={onSelect}
        disabled={setDefault.isPending || flowsQ.isLoading}
      >
        <SelectTrigger className="h-8 w-full">
          <SelectValue placeholder="None" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_FLOW_VALUE}>None</SelectItem>
          {enabledOrCurrent.map((f) => (
            <SelectItem key={f.id} value={f.id}>
              {f.name}{!f.enabled ? " (disabled)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {setDefault.error && (
        <div className="text-xs text-destructive">
          {setDefault.error instanceof Error
            ? setDefault.error.message
            : String(setDefault.error)}
        </div>
      )}
    </section>
  );
}

const NO_AGENT_VALUE = "__none";

function DefaultImplementAgentSection({
  projectId,
  currentAgentId,
}: {
  projectId: string;
  currentAgentId: string | null;
}) {
  const agentsQ = useQuery(agentsQuery());
  const setDefault = useSetProjectDefaultImplementAgent(projectId);
  const agents = agentsQ.data?.agents ?? [];
  const value = currentAgentId ?? NO_AGENT_VALUE;

  const onSelect = (next: string) => {
    if (next === value) return;
    setDefault.mutate(next === NO_AGENT_VALUE ? null : next);
  };

  return (
    <section className="space-y-2 text-sm">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">
        Implement agent
      </Label>
      <p className="text-xs text-muted-foreground">
        Default agent for the implement flow. Pre-populates the Agent dropdown
        on each kanban card; a per-card pick overrides it without changing this
        default.
      </p>
      <Select
        value={value}
        onValueChange={onSelect}
        disabled={setDefault.isPending || agentsQ.isLoading}
      >
        <SelectTrigger className="h-8 w-full">
          <SelectValue placeholder="None" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_AGENT_VALUE}>None</SelectItem>
          {agents.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {setDefault.error && (
        <div className="text-xs text-destructive">
          {setDefault.error instanceof Error
            ? setDefault.error.message
            : String(setDefault.error)}
        </div>
      )}
    </section>
  );
}

const NO_PROMPT_VALUE = "__none";

function DefaultImplementPromptSection({
  projectId,
  currentPromptId,
}: {
  projectId: string;
  currentPromptId: string | null;
}) {
  const promptsQ = useQuery(promptsQuery());
  const setDefault = useSetProjectDefaultImplementPrompt(projectId);
  const prompts = promptsQ.data?.prompts ?? [];
  const value = currentPromptId ?? NO_PROMPT_VALUE;

  const onSelect = (next: string) => {
    if (next === value) return;
    setDefault.mutate(next === NO_PROMPT_VALUE ? null : next);
  };

  return (
    <section className="space-y-2 text-sm">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">
        Implement prompt
      </Label>
      <p className="text-xs text-muted-foreground">
        Default prompt for the implement flow, injected as the agent's task
        instructions. Pre-populates the Prompt dropdown on each kanban card; a
        per-card pick overrides it. Manage named prompts on the Prompts page.
      </p>
      <Select
        value={value}
        onValueChange={onSelect}
        disabled={setDefault.isPending || promptsQ.isLoading}
      >
        <SelectTrigger className="h-8 w-full">
          <SelectValue placeholder="None" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_PROMPT_VALUE}>None</SelectItem>
          {prompts.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {setDefault.error && (
        <div className="text-xs text-destructive">
          {setDefault.error instanceof Error
            ? setDefault.error.message
            : String(setDefault.error)}
        </div>
      )}
    </section>
  );
}

function InstructionsFileSection({
  projectId,
  current,
}: {
  projectId: string;
  current: string;
}) {
  const setInstructionsFile = useSetProjectInstructionsFile(projectId);
  const [draft, setDraft] = useState(current);
  // Re-sync the draft if the persisted value changes underneath us (e.g.
  // the project query refetches with a value edited elsewhere) so the
  // input never shows stale text against the server state.
  useEffect(() => {
    setDraft(current);
  }, [current]);
  const trimmed = draft.trim();
  const dirty = trimmed !== current;
  // Mirror the server-side validation in `validateInstructionsFileInput`
  // so the operator sees rejection reasons inline instead of clicking
  // Save just to discover the value was bad. Empty string is allowed
  // (= disable injection for this project).
  const localError = (() => {
    if (trimmed.length === 0) return null;
    if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
      return "Must be a repo-relative path, not absolute.";
    }
    if (trimmed.split(/[\\/]/).includes("..")) {
      return "Must not contain '..' segments.";
    }
    if (!/\.md$/i.test(trimmed)) {
      return "Must end in .md.";
    }
    return null;
  })();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (localError || !dirty || setInstructionsFile.isPending) return;
    // Sync the input with the trimmed value before sending. Without
    // this, an operator typing "AGENTS.md  " saves the right value
    // ("AGENTS.md") on the server but the input keeps the trailing
    // spaces visible, making the disabled Save button look broken
    // ("the field is dirty but Save is greyed out").
    setDraft(trimmed);
    setInstructionsFile.mutate(trimmed);
  };

  return (
    <section>
      <form onSubmit={submit} className="space-y-2 text-sm">
        <Label
          htmlFor="instructions-file"
          className="text-xs uppercase tracking-wide text-muted-foreground"
        >
          Agent instructions file
        </Label>
        <p className="text-xs text-muted-foreground">
          Repo-relative path. Read from the worktree at dispatch and
          injected as the canonical project system prompt for every
          agent — replaces each CLI's per-kind auto-discovery (e.g.{" "}
          <code className="font-mono">~/.claude/CLAUDE.md</code>) so the
          agent's instructions are identical across kinds. Leave empty
          to disable injection.
        </p>
        <div className="flex items-center gap-2">
          <Input
            id="instructions-file"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="AGENTS.md"
            className="h-8 max-w-md font-mono text-xs"
            spellCheck={false}
            autoComplete="off"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={
              !dirty || setInstructionsFile.isPending || localError !== null
            }
          >
            {setInstructionsFile.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        {localError && (
          <div className="text-xs text-destructive">{localError}</div>
        )}
        {setInstructionsFile.error && !localError && (
          <div className="text-xs text-destructive">
            {setInstructionsFile.error instanceof Error
              ? setInstructionsFile.error.message
              : String(setInstructionsFile.error)}
          </div>
        )}
      </form>
    </section>
  );
}
