import { useEffect, useRef, useState } from "react";
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
  useCreateAgent,
  useDeleteAgent,
  useTestAgent,
  useUpdateAgent,
  type AgentRow,
} from "@/lib/queries";
import { ApiError } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useRegisterChatAction } from "@/lib/chatActions";

type RunOn = "any" | "local" | "device";

export function AgentsPage() {
  const q = useQuery(agentsQuery());
  const location = useLocation();

  // When the page is opened with a hash like #agent-<id> (typically via the
  // sidebar's nested agent links), scroll the matching card into view once
  // the agent list has actually loaded. Re-runs whenever the hash changes so
  // re-clicking the same sidebar entry while already on /agents still scrolls.
  useEffect(() => {
    if (!q.data?.agents.length) return;
    const hash = location.hash;
    if (!hash.startsWith("#agent-")) return;
    const el = document.getElementById(hash.slice(1));
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("ring-2", "ring-primary/60");
    const t = setTimeout(() => {
      el.classList.remove("ring-2", "ring-primary/60");
    }, 1500);
    // Clean up BOTH the timer and the highlight class. Without removing the
    // class here, switching agents before the timeout fires would cancel the
    // pending removal and leave the previous card stuck in the highlighted
    // state.
    return () => {
      clearTimeout(t);
      el.classList.remove("ring-2", "ring-primary/60");
    };
  }, [location.hash, q.data?.agents]);

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
  const [runOn, setRunOn] = useState<RunOn>("any");
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
            <Label htmlFor="new-agent-runon">Run on</Label>
            <Select value={runOn} onValueChange={(v) => setRunOn(v as RunOn)}>
              <SelectTrigger id="new-agent-runon">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">any (prefer device, fall back local)</SelectItem>
                <SelectItem value="device">device only</SelectItem>
                <SelectItem value="local">local subprocess only</SelectItem>
              </SelectContent>
            </Select>
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
                { name: name.trim(), command: command.trim(), env, runOn },
                {
                  onSuccess: () => {
                    setName("");
                    setCommand("");
                    setEnvText("");
                    setRunOn("any");
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
  const [runOn, setRunOn] = useState<RunOn>(agent.runOn);
  const update = useUpdateAgent();
  const remove = useDeleteAgent();

  const reset = () => {
    setName(agent.name);
    setCommand(joinCommand(agent));
    setEnvText(Object.entries(agent.env).map(([k, v]) => `${k}=${v}`).join("\n"));
    setRunOn(agent.runOn);
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
              <Badge variant="outline">{agent.runOn}</Badge>
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
                          runOn,
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
              <Label>Run on</Label>
              <Select value={runOn} onValueChange={(v) => setRunOn(v as RunOn)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">any</SelectItem>
                  <SelectItem value="device">device only</SelectItem>
                  <SelectItem value="local">local subprocess only</SelectItem>
                </SelectContent>
              </Select>
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

function TestAgentDialog({ agent, open, onOpenChange }: TestAgentDialogProps) {
  const [prompt, setPrompt] = useState("Hello! Please respond briefly.");
  const [target, setTarget] = useState<"default" | RunOn>("default");
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const test = useTestAgent();
  const errorBody = test.error instanceof ApiError ? test.error.body : null;

  // Reset between opens so a fresh dialog isn't pre-populated with last
  // session's output / pending state.
  useEffect(() => {
    if (!open) {
      setAgentRunId(null);
      test.reset();
    }
  }, [open, test]);

  const onRun = () => {
    test.mutate(
      {
        id: agent.id,
        prompt,
        runOn: target === "default" ? undefined : target,
      },
      {
        onSuccess: ({ agentRunId: id }) => setAgentRunId(id),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Test agent: {agent.name}</DialogTitle>
          <DialogDescription>
            Spawns a one-off run with the prompt as stdin (
            <code className="font-mono text-xs">{`{ "message": "..." }`}</code>) and
            <code className="ml-1 font-mono text-xs">OPENKIRA_TEST=1</code> in
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
            <Label htmlFor="test-target">Run target</Label>
            <Select
              value={target}
              onValueChange={(v) => setTarget(v as "default" | RunOn)}
              disabled={!!agentRunId}
            >
              <SelectTrigger id="test-target" className="w-full max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">
                  agent default ({agent.runOn})
                </SelectItem>
                <SelectItem value="any">any (prefer device, fallback local)</SelectItem>
                <SelectItem value="local">local subprocess only</SelectItem>
                <SelectItem value="device">device only (any online)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Picking a specific device by name isn't supported yet — the
              dispatcher routes to any idle one.
            </p>
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
                onClick={onRun}
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
  const lastRunRef = useRef<string | null>(null);

  useEffect(() => {
    setChunks("");
    setStatus("live");
    if (lastRunRef.current === agentRunId) return;
    lastRunRef.current = agentRunId;
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
