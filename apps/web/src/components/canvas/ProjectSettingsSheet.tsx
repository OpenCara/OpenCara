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
  projectSchedulesQuery,
  promptsQuery,
  useCreateSchedule,
  useDeleteSchedule,
  useSetProjectDefaultImplementAgent,
  useSetProjectDefaultImplementFlow,
  useSetProjectDefaultImplementPrompt,
  useSetProjectInstructionsFile,
  useUpdateSchedule,
  type ScheduleSummary,
} from "@/lib/queries";
import { useCronPreview, CronPreview } from "@/components/flow/cron-preview";

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
          <ScheduledTasksSection projectId={projectId} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

const DEFAULT_TZ =
  typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    : "UTC";

/**
 * Per-project scheduled tasks (#128). Each schedule is a dedicated flow with a
 * `schedule.cron` trigger; this section is the flat create / edit / pause /
 * delete surface over them. The agent each schedule runs is the project's
 * default implement agent — wire up that default above for the runs to do
 * useful work.
 */
function ScheduledTasksSection({ projectId }: { projectId: string }) {
  const schedulesQ = useQuery(projectSchedulesQuery(projectId));
  const schedules = schedulesQ.data?.schedules ?? [];

  return (
    <section className="space-y-3">
      <div>
        <Label className="text-sm font-medium">Scheduled tasks</Label>
        <p className="text-xs text-muted-foreground">
          Run a flow on a recurring cron schedule (e.g. nightly audits). Each
          schedule dispatches the project&apos;s default implement agent.
        </p>
      </div>

      {schedulesQ.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : schedules.length === 0 ? (
        <p className="text-xs text-muted-foreground">No scheduled tasks yet.</p>
      ) : (
        <ul className="space-y-2">
          {schedules.map((s) => (
            <ScheduleRow key={s.flowId} projectId={projectId} schedule={s} />
          ))}
        </ul>
      )}

      <CreateScheduleForm projectId={projectId} />
    </section>
  );
}

function ScheduleRow({
  projectId,
  schedule,
}: {
  projectId: string;
  schedule: ScheduleSummary;
}) {
  const [editing, setEditing] = useState(false);
  const update = useUpdateSchedule(projectId);
  const del = useDeleteSchedule(projectId);

  const toggleEnabled = () =>
    update.mutate({ flowId: schedule.flowId, enabled: !schedule.enabled });

  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{schedule.name}</span>
            {!schedule.enabled && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                Paused
              </span>
            )}
          </div>
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            {schedule.cron} · {schedule.timezone}
          </div>
          {schedule.cronError ? (
            <div className="mt-1 text-xs text-destructive">{schedule.cronError}</div>
          ) : schedule.nextFireTimes[0] ? (
            <div className="mt-1 text-xs text-muted-foreground">
              Next: {new Date(schedule.nextFireTimes[0]).toLocaleString()}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" onClick={toggleEnabled} disabled={update.isPending}>
            {schedule.enabled ? "Pause" : "Resume"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>
            {editing ? "Cancel" : "Edit"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={del.isPending}
            onClick={() => {
              if (confirm(`Delete schedule "${schedule.name}"?`)) {
                del.mutate(schedule.flowId);
              }
            }}
          >
            Delete
          </Button>
        </div>
      </div>

      {editing && (
        <ScheduleEditForm
          projectId={projectId}
          schedule={schedule}
          onDone={() => setEditing(false)}
        />
      )}
    </li>
  );
}

function ScheduleEditForm({
  projectId,
  schedule,
  onDone,
}: {
  projectId: string;
  schedule: ScheduleSummary;
  onDone: () => void;
}) {
  const [name, setName] = useState(schedule.name);
  const [cron, setCron] = useState(schedule.cron);
  const [timezone, setTimezone] = useState(schedule.timezone);
  const update = useUpdateSchedule(projectId);
  const preview = useCronPreview(cron, timezone);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!preview.valid) return;
    update.mutate(
      { flowId: schedule.flowId, name: name.trim() || "Scheduled task", cron: cron.trim(), timezone: timezone.trim() || "UTC" },
      { onSuccess: onDone },
    );
  };

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-2 border-t border-border pt-3">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      <Input
        value={cron}
        onChange={(e) => setCron(e.target.value)}
        placeholder="0 9 * * *"
        className="font-mono text-xs"
      />
      <Input
        value={timezone}
        onChange={(e) => setTimezone(e.target.value)}
        placeholder="UTC"
        className="font-mono text-xs"
      />
      <CronPreview preview={preview} />
      {update.error && (
        <div className="text-xs text-destructive">
          {(update.error as Error).message ?? "Save failed"}
        </div>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={update.isPending || !preview.valid}>
          {update.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function CreateScheduleForm({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("Scheduled task");
  const [cron, setCron] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState(DEFAULT_TZ);
  const create = useCreateSchedule(projectId);
  const preview = useCronPreview(cron, timezone);

  const reset = () => {
    setName("Scheduled task");
    setCron("0 9 * * *");
    setTimezone(DEFAULT_TZ);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!preview.valid) return;
    create.mutate(
      { name: name.trim() || "Scheduled task", cron: cron.trim(), timezone: timezone.trim() || "UTC" },
      {
        onSuccess: () => {
          reset();
          setOpen(false);
        },
      },
    );
  };

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        + Add scheduled task
      </Button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2 rounded-md border border-border p-3">
      <div className="text-sm font-medium">New scheduled task</div>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      <Input
        value={cron}
        onChange={(e) => setCron(e.target.value)}
        placeholder="0 9 * * *"
        className="font-mono text-xs"
      />
      <p className="text-xs text-muted-foreground">
        Standard 5-field cron: minute hour day-of-month month day-of-week.
      </p>
      <Input
        value={timezone}
        onChange={(e) => setTimezone(e.target.value)}
        placeholder="UTC"
        className="font-mono text-xs"
      />
      <CronPreview preview={preview} />
      {create.error && (
        <div className="text-xs text-destructive">
          {(create.error as Error).message ?? "Create failed"}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            reset();
            setOpen(false);
          }}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={create.isPending || !preview.valid}>
          {create.isPending ? "Creating…" : "Create"}
        </Button>
      </div>
    </form>
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
