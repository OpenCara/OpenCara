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
import { formatRelative } from "@/lib/format";
import { useRegisterChatAction } from "@/lib/chatActions";

// "__any" sentinel = "any idle device" (mapped to null when sent to the
// API). Radix's <SelectItem> rejects empty-string values (reserved for
// the placeholder), so use a clearly-namespaced literal that can't
// collide with a real ULID device id.
const ANY_DEVICE = "__any" as const;

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
          Reusable agent definitions (command + env). Linked to a flow's
          agent node from the flow detail page; the linked agent's spec is what
          actually runs.
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
  const [command, setCommand] = useState("");
  const [envText, setEnvText] = useState("");
  const [hostId, setHostId] = useState<string>(ANY_DEVICE);
  const devicesQ = useQuery(devicesQuery());
  const create = useCreateAgent();
  const error = create.error instanceof ApiError ? create.error.body : null;

  // Let the chat panel's "Apply as command" button drop suggestions straight
  // into this draft form (multi-line replies are flattened so the input keeps
  // working as a single line).
  useRegisterChatAction("command", (text) =>
    setCommand(text.trim().split(/\r?\n/).join(" ")),
  );
  useRegisterChatAction("agent-env", (text) => setEnvText(text.trim()));

  const env = parseEnv(envText);

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
        <div>
          <Label htmlFor="new-agent-command">Command</Label>
          <Input
            id="new-agent-command"
            placeholder='e.g. node /usr/local/bin/reviewer.mjs --model claude-sonnet-4-6'
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            className="font-mono text-xs"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Full invocation. Use double or single quotes for arguments containing spaces.
          </p>
        </div>
        <div>
          <Label htmlFor="new-agent-env">Env vars (KEY=value, one per line)</Label>
          <Textarea
            id="new-agent-env"
            placeholder={"ANTHROPIC_API_KEY=..."}
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            className="min-h-20 font-mono text-xs"
          />
        </div>
        {error !== null && error !== undefined && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {extractErr(error)}
          </div>
        )}
        <div className="flex justify-end">
          <Button
            disabled={!name.trim() || !command.trim() || create.isPending}
            onClick={() =>
              create.mutate(
                {
                  name: name.trim(),
                  command: command.trim(),
                  env,
                  hostId: hostId === ANY_DEVICE ? null : hostId,
                },
                {
                  onSuccess: () => {
                    setName("");
                    setCommand("");
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
  const [command, setCommand] = useState(joinCommand(agent));
  const [envText, setEnvText] = useState(
    Object.entries(agent.env).map(([k, v]) => `${k}=${v}`).join("\n"),
  );
  const [hostId, setHostId] = useState<string>(agent.hostId ?? ANY_DEVICE);
  const devicesQ = useQuery(devicesQuery());
  const update = useUpdateAgent();
  const remove = useDeleteAgent();

  const reset = () => {
    setName(agent.name);
    setCommand(joinCommand(agent));
    setEnvText(Object.entries(agent.env).map(([k, v]) => `${k}=${v}`).join("\n"));
    setHostId(agent.hostId ?? ANY_DEVICE);
  };

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
              <Badge variant="outline">
                {agent.hostId
                  ? devicesQ.data?.devices.find((d) => d.id === agent.hostId)?.name ??
                    "deleted device"
                  : "any device"}
              </Badge>
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
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate(
                      {
                        id: agent.id,
                        patch: {
                          name: name.trim(),
                          command: command.trim(),
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
            <div>
              <Label>Command</Label>
              <Input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                className="font-mono text-xs"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Full invocation. Quote arguments with spaces.
              </p>
            </div>
            <div>
              <Label>Env (KEY=value)</Label>
              <Textarea
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                className="min-h-20 font-mono text-xs"
              />
            </div>
          </>
        ) : (
          <pre className="whitespace-pre-wrap rounded-md bg-muted/30 p-3 font-mono text-xs leading-relaxed">
            {[`$ ${agent.command}${agent.args.length ? " " : ""}${agent.args.join(" ")}`]
              .concat(
                Object.entries(agent.env).length > 0
                  ? Object.entries(agent.env).map(
                      ([k, v]) => `  ${k}=${v.length > 32 ? v.slice(0, 32) + "…" : v}`,
                    )
                  : [],
              )
              .join("\n")}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Stitch a stored agent's command + args back into a single shell-style
 * string for the editor input. Args containing whitespace are double-quoted
 * so a round-trip through the server's tokenizer recovers them exactly.
 */
function joinCommand(agent: { command: string; args: string[] }): string {
  // The server tokenizer honours " and ' but not backslash escapes. Pick the
  // quote style that doesn't conflict with the arg's contents so a round-trip
  // through edit → save survives intact for the common cases.
  const quote = (s: string) => {
    if (!/\s|"|'/.test(s)) return s;
    if (!s.includes('"')) return `"${s}"`;
    if (!s.includes("'")) return `'${s}'`;
    return `"${s}"`; // mixed quotes — user will need to fix manually
  };
  return [agent.command, ...agent.args].map(quote).join(" ");
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
            Spawns a one-off run with the prompt as stdin (
            <code className="font-mono text-xs">{`{ "message": "..." }`}</code>) and
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
  const [chunks, setChunks] = useState("");
  const [status, setStatus] = useState<"live" | "ended" | "error">("live");

  useEffect(() => {
    setChunks("");
    setStatus("live");
    const es = new EventSource(`/api/runs/${agentRunId}/logs/stream`, {
      withCredentials: true,
    });
    es.addEventListener("log", (e: MessageEvent) => {
      try {
        const row = JSON.parse(e.data) as { stream: string; chunk: string };
        setChunks((prev) => prev + row.chunk);
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
      <pre className="max-h-72 overflow-auto rounded-md bg-muted/30 p-3 font-mono text-xs leading-relaxed">
        {chunks || "(waiting…)"}
      </pre>
    </div>
  );
}
