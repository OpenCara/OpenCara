import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Pencil, Play, Trash2, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  agentsQuery,
  devicesQuery,
  useCreateAgent,
  useDeleteAgent,
  useTestAgent,
  useUpdateAgent,
  type AgentRow,
  type DeviceRow,
} from "@/lib/queries";
import { ApiError } from "@/lib/api";
import {
  AgentLogStream,
  type AgentLogLine,
} from "@/components/chat/AgentOutput";
import { formatRelative } from "@/lib/format";
import { parseModelRef, THINKING_LEVELS } from "@opencara/shared";
import { useRegisterChatAction } from "@/lib/chatActions";

// "__any" sentinel = "any idle device" (mapped to null when sent to the
// API). Radix's <SelectItem> rejects empty-string values (reserved for
// the placeholder), so use a clearly-namespaced literal that can't
// collide with a real ULID device id.
const ANY_DEVICE = "__any" as const;

// Select value standing in for thoughtLevel = null (the device's pi
// default). Radix's <SelectItem> rejects empty-string values.
const PI_DEFAULT = "__default" as const;

const ENV_HINT =
  "Passed to the agent's runs on the device and its shell commands. Provider keys here (ANTHROPIC_API_KEY=… / OPENAI_API_KEY=…) override the device's pi credentials for this agent.";

function isValidModel(model: string): boolean {
  return parseModelRef(model.trim()) !== null;
}

function ModelField(props: { id: string; value: string; onChange: (next: string) => void }) {
  const invalid = props.value.trim() !== "" && !isValidModel(props.value);
  return (
    <div>
      <Label htmlFor={props.id}>Model</Label>
      <Input
        id={props.id}
        placeholder="anthropic/claude-sonnet-5-5"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="font-mono text-xs"
        aria-invalid={invalid}
      />
      <p className={`mt-1 text-xs ${invalid ? "text-destructive" : "text-muted-foreground"}`}>
        {invalid ? "Expected provider/modelId. " : ""}
        <code>provider/modelId</code> as pi names it. Providers and keys come from
        the device&apos;s pi config (<code>~/.pi/agent/models.json</code>,{" "}
        <code>pi</code> <code>/login</code>) or this agent&apos;s env.
      </p>
    </div>
  );
}

function ThoughtLevelField(props: {
  id: string;
  /** "" = the device's pi default. */
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div>
      <Label htmlFor={props.id}>Thinking level</Label>
      <Select
        value={props.value === "" ? PI_DEFAULT : props.value}
        onValueChange={(v) => props.onChange(v === PI_DEFAULT ? "" : v)}
      >
        <SelectTrigger id={props.id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={PI_DEFAULT}>pi default</SelectItem>
          {THINKING_LEVELS.map((l) => (
            <SelectItem key={l} value={l}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CaptureThinkingField(props: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div>
      <label htmlFor={props.id} className="flex items-center gap-2 text-sm font-medium">
        <input
          id={props.id}
          type="checkbox"
          checked={props.checked}
          onChange={(e) => props.onChange(e.target.checked)}
          className="size-4 rounded border-input"
        />
        <span>Capture agent thinking</span>
      </label>
      <p className="mt-1 text-xs text-muted-foreground">
        Off means the device discards this agent&apos;s reasoning as it streams —
        nothing is stored, so there is no <code>[think]</code> block in the run
        logs and no way to get it back for a past run. Useful when the reasoning
        dwarfs the output.
      </p>
    </div>
  );
}

interface DevicePickerProps {
  /** "" = any device, otherwise a host id. */
  value: string;
  onChange: (next: string) => void;
  devices: DeviceRow[];
  /** Show "(use agent's saved pin)" as the first option. Test-dialog only. */
  defaultLabel?: string;
  /** Sentinel for the default option. Required if defaultLabel is set. */
  defaultValue?: string;
  id?: string;
}

function DevicePicker(props: DevicePickerProps) {
  const live = props.devices.filter((d) => !d.revokedAt);
  return (
    <Select value={props.value} onValueChange={props.onChange}>
      <SelectTrigger id={props.id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {props.defaultLabel && props.defaultValue !== undefined && (
          <SelectItem value={props.defaultValue}>{props.defaultLabel}</SelectItem>
        )}
        <SelectItem value={ANY_DEVICE}>Any idle device</SelectItem>
        {live.map((d) => (
          <SelectItem key={d.id} value={d.id}>
            {d.name}
            {d.online ? "" : " (offline)"}
          </SelectItem>
        ))}
        {live.length === 0 && (
          <SelectItem value="__no_devices" disabled>
            (no devices paired — run `opencara` on a machine)
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

export function AgentsPage() {
  const q = useQuery(agentsQuery());
  const location = useLocation();

  // Scroll + flash the card whose id matches the URL hash (sidebar's nested
  // agent links land here as /agents#agent-<id>). Depend on the list-loaded
  // boolean, NOT q.data.agents — that array's identity changes on every
  // refetch (any field touch on any agent, or the chat panel's broad
  // qc.invalidateQueries() after a turn) and would re-trigger scrollIntoView
  // on each refetch. Use behavior:"auto" to avoid wedging the page if the
  // user navigates away mid-animation: a smooth scroll on an overflow-y-auto
  // container whose child is being unmounted leaves Chromium in a state
  // where subsequent sidebar clicks don't switch routes.
  const agentsLoaded = (q.data?.agents.length ?? 0) > 0;
  useEffect(() => {
    if (!agentsLoaded) return;
    const hash = location.hash;
    if (!hash.startsWith("#agent-")) return;
    const el = document.getElementById(hash.slice(1));
    if (!el) return;
    el.scrollIntoView({ behavior: "auto", block: "start" });
    el.classList.add("ring-2", "ring-primary/60");
    const t = setTimeout(() => {
      el.classList.remove("ring-2", "ring-primary/60");
    }, 1500);
    return () => {
      clearTimeout(t);
      el.classList.remove("ring-2", "ring-primary/60");
    };
  }, [location.hash, agentsLoaded]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
        <p className="text-sm text-muted-foreground">
          Reusable agent definitions (model + thinking level + env). Each run is
          a conversation the device executes itself. Linked to a flow's agent
          node from the flow detail page; the linked agent is what actually
          runs.
        </p>
      </div>

      <NewAgentCard />

      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : !q.data?.agents.length ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No agents yet. Create one above.
        </div>
      ) : (
        <div className="space-y-4">
          {q.data.agents.map((a) => (
            <AgentCard key={a.id} agent={a} />
          ))}
        </div>
      )}
    </div>
  );
}


function NewAgentCard() {
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [thoughtLevel, setThoughtLevel] = useState("");
  const [captureThinking, setCaptureThinking] = useState(true);
  const [envText, setEnvText] = useState("");
  const [hostId, setHostId] = useState<string>(ANY_DEVICE);
  const devicesQ = useQuery(devicesQuery());
  const create = useCreateAgent();
  const error = create.error instanceof ApiError ? create.error.body : null;

  useRegisterChatAction("agent-env", (text) => setEnvText(text.trim()));

  const canSave = name.trim().length > 0 && isValidModel(model);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium text-muted-foreground">
          New agent
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <Label htmlFor="new-agent-name">Name</Label>
            <Input
              id="new-agent-name"
              placeholder="e.g. Claude reviewer"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="new-agent-device">Device</Label>
            <DevicePicker
              id="new-agent-device"
              value={hostId}
              onChange={setHostId}
              devices={devicesQ.data?.devices ?? []}
            />
          </div>
        </div>
        <ModelField id="new-agent-model" value={model} onChange={setModel} />
        <ThoughtLevelField
          id="new-agent-thought-level"
          value={thoughtLevel}
          onChange={setThoughtLevel}
        />
        <CaptureThinkingField
          id="new-agent-capture-thinking"
          checked={captureThinking}
          onChange={setCaptureThinking}
        />
        <div>
          <Label htmlFor="new-agent-env">Env vars (KEY=value, one per line)</Label>
          <Textarea
            id="new-agent-env"
            placeholder={"ANTHROPIC_API_KEY=..."}
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            className="min-h-20 font-mono text-xs"
          />
          <p className="mt-1 text-xs text-muted-foreground">{ENV_HINT}</p>
        </div>
        {error !== null && error !== undefined && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {extractErr(error)}
          </div>
        )}
        <div className="flex justify-end">
          <Button
            disabled={!canSave || create.isPending}
            onClick={() =>
              create.mutate(
                {
                  name: name.trim(),
                  model: model.trim(),
                  thoughtLevel: thoughtLevel || null,
                  captureThinking,
                  env: parseEnv(envText),
                  hostId: hostId === ANY_DEVICE ? null : hostId,
                },
                {
                  onSuccess: () => {
                    setName("");
                    setModel("");
                    setThoughtLevel("");
                    setCaptureThinking(true);
                    setEnvText("");
                    setHostId(ANY_DEVICE);
                  },
                },
              )
            }
          >
            {create.isPending ? "Saving…" : "Save agent"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AgentCard({ agent }: { agent: AgentRow }) {
  const [editing, setEditing] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [name, setName] = useState(agent.name);
  const [model, setModel] = useState(agent.model);
  const [envText, setEnvText] = useState(
    Object.entries(agent.env).map(([k, v]) => `${k}=${v}`).join("\n"),
  );
  const [hostId, setHostId] = useState<string>(agent.hostId ?? ANY_DEVICE);
  const [captureThinking, setCaptureThinking] = useState(agent.captureThinking);
  const [thoughtLevel, setThoughtLevel] = useState(agent.thoughtLevel ?? "");
  const devicesQ = useQuery(devicesQuery());
  const update = useUpdateAgent();
  const remove = useDeleteAgent();
  const error = update.error instanceof ApiError ? update.error.body : null;

  const reset = () => {
    setName(agent.name);
    setModel(agent.model);
    setEnvText(Object.entries(agent.env).map(([k, v]) => `${k}=${v}`).join("\n"));
    setHostId(agent.hostId ?? ANY_DEVICE);
    setCaptureThinking(agent.captureThinking);
    setThoughtLevel(agent.thoughtLevel ?? "");
  };

  const canSave = name.trim().length > 0 && isValidModel(model);
  const deviceLabel = agent.hostId
    ? devicesQ.data?.devices.find((d) => d.id === agent.hostId)?.name ?? "deleted device"
    : "any device";

  return (
    <Card id={`agent-${agent.id}`} className="scroll-mt-4 transition-shadow">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {editing ? (
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            ) : (
              <CardTitle className="text-base">{agent.name}</CardTitle>
            )}
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span>Updated {formatRelative(agent.updatedAt)}</span>
              <Badge variant="outline">{deviceLabel}</Badge>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {editing ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing(false);
                    reset();
                  }}
                >
                  <X className="size-4" />
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={!canSave || update.isPending}
                  onClick={() =>
                    update.mutate(
                      {
                        id: agent.id,
                        patch: {
                          name: name.trim(),
                          model: model.trim(),
                          thoughtLevel: thoughtLevel || null,
                          captureThinking,
                          env: parseEnv(envText),
                          hostId: hostId === ANY_DEVICE ? null : hostId,
                        },
                      },
                      { onSuccess: () => setEditing(false) },
                    )
                  }
                >
                  {update.isPending ? "Saving…" : "Save"}
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="outline" onClick={() => setTestOpen(true)}>
                  <Play className="size-4" />
                  Test
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  <Pencil className="size-4" />
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm(`Delete agent "${agent.name}"?`)) {
                      remove.mutate(agent.id);
                    }
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
                <TestAgentDialog
                  agent={agent}
                  open={testOpen}
                  onOpenChange={setTestOpen}
                />
              </>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {editing ? (
          <>
            <div>
              <Label>Device</Label>
              <DevicePicker
                value={hostId}
                onChange={setHostId}
                devices={devicesQ.data?.devices ?? []}
              />
            </div>
            <ModelField id={`agent-model-${agent.id}`} value={model} onChange={setModel} />
            <ThoughtLevelField
              id={`agent-thought-level-${agent.id}`}
              value={thoughtLevel}
              onChange={setThoughtLevel}
            />
            <CaptureThinkingField
              id={`agent-capture-thinking-${agent.id}`}
              checked={captureThinking}
              onChange={setCaptureThinking}
            />
            <div>
              <Label>Env (KEY=value)</Label>
              <Textarea
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                className="min-h-20 font-mono text-xs"
              />
              <p className="mt-1 text-xs text-muted-foreground">{ENV_HINT}</p>
            </div>
            {error !== null && error !== undefined && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {extractErr(error)}
              </div>
            )}
          </>
        ) : (
          <pre className="whitespace-pre-wrap rounded-md bg-muted/30 p-3 font-mono text-xs leading-relaxed">
            {[
              `model: ${agent.model}`,
              `thinking level: ${agent.thoughtLevel ?? "pi default"}${
                agent.captureThinking ? "" : " (not captured)"
              }`,
              `device: ${deviceLabel}`,
            ]
              .concat(
                Object.keys(agent.env).map((k) => `  ${k}=••••••`),
              )
              .join("\n")}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1);
  }
  return out;
}

function extractErr(err: unknown): string {
  if (err && typeof err === "object" && "error" in err) {
    const v = (err as { error: unknown }).error;
    return typeof v === "string" ? v : JSON.stringify(v);
  }
  return "Save failed";
}

interface TestAgentDialogProps {
  agent: AgentRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// "__default" = use the agent's saved hostId. Mapped to omitting the
// `hostId` field on the request so the server falls back to agent.hostId.
const HOST_DEFAULT = "__default" as const;

function TestAgentDialog({ agent, open, onOpenChange }: TestAgentDialogProps) {
  const [prompt, setPrompt] = useState("Hello! Please respond briefly.");
  const [hostOverride, setHostOverride] = useState<string>(HOST_DEFAULT);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const devicesQ = useQuery(devicesQuery());
  const test = useTestAgent();
  const errorBody = test.error instanceof ApiError ? test.error.body : null;

  // Depend on the stable `reset` reference, not the whole mutation object.
  const reset = test.reset;
  useEffect(() => {
    if (!open) {
      setAgentRunId(null);
      reset();
    }
  }, [open, reset]);

  const handleRun = () => {
    // Two-tier override: HOST_DEFAULT means "use saved pin" (omit field);
    // ANY_DEVICE means "explicitly any" (send null).
    const overrideArg =
      hostOverride === HOST_DEFAULT
        ? {}
        : { hostId: hostOverride === ANY_DEVICE ? null : hostOverride };
    test.mutate(
      { id: agent.id, prompt, ...overrideArg },
      { onSuccess: ({ agentRunId: id }) => setAgentRunId(id) },
    );
  };

  const savedDeviceLabel = agent.hostId
    ? devicesQ.data?.devices.find((d) => d.id === agent.hostId)?.name ??
      "deleted device"
    : "any device";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Test agent: {agent.name}</DialogTitle>
          <DialogDescription>
            Runs the prompt as a one-off conversation on the device with
            <code className="ml-1 font-mono text-xs">OPENCARA_TEST=1</code> in
            the env.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="test-prompt">Prompt</Label>
            <Textarea
              id="test-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="min-h-24 font-mono text-xs"
              disabled={!!agentRunId}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="test-target">Run on</Label>
            <DevicePicker
              id="test-target"
              value={hostOverride}
              onChange={(v) => !agentRunId && setHostOverride(v)}
              devices={devicesQ.data?.devices ?? []}
              defaultLabel={`agent default (${savedDeviceLabel})`}
              defaultValue={HOST_DEFAULT}
            />
          </div>

          {errorBody !== null && errorBody !== undefined && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {extractErr(errorBody)}
            </div>
          )}

          {agentRunId && <TestRunLog agentRunId={agentRunId} />}
        </div>

        <DialogFooter>
          {agentRunId ? (
            <>
              <Button variant="outline" onClick={() => setAgentRunId(null)}>
                Run again
              </Button>
              <Button onClick={() => onOpenChange(false)}>Close</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                disabled={!prompt.trim() || test.isPending}
                onClick={handleRun}
              >
                <Play className="size-3.5" />
                {test.isPending ? "Starting…" : "Run test"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TestRunLog({ agentRunId }: { agentRunId: string }) {
  const [events, setEvents] = useState<AgentLogLine[]>([]);
  const [status, setStatus] = useState<"live" | "ended" | "error">("live");

  useEffect(() => {
    setEvents([]);
    setStatus("live");
    const es = new EventSource(`/api/runs/${agentRunId}/logs/stream`, {
      withCredentials: true,
    });
    es.addEventListener("log", (e: MessageEvent) => {
      try {
        const row = JSON.parse(e.data) as {
          seq: number;
          stream: "stdout" | "stderr";
          chunk: string;
        };
        setEvents((prev) => [...prev, row]);
      } catch {
        // ignore malformed frame
      }
    });
    es.addEventListener("end", () => {
      setStatus("ended");
      es.close();
    });
    es.onerror = () => {
      setStatus("error");
    };
    return () => {
      es.close();
    };
  }, [agentRunId]);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs uppercase tracking-wide text-muted-foreground">
        <span>Output</span>
        <span>{status}</span>
      </div>
      {/* min-w-0 lets flex/grid parents shrink the panel below its content
          width — without it the content dictates the dialog width. */}
      <div className="min-w-0 max-h-72 overflow-auto rounded-md bg-muted/30 p-3">
        <AgentLogStream events={events} empty="(waiting…)" />
      </div>
    </div>
  );
}
