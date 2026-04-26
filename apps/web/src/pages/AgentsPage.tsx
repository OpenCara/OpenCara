import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil, Trash2, X } from "lucide-react";
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
  agentsQuery,
  useCreateAgent,
  useDeleteAgent,
  useUpdateAgent,
  type AgentRow,
} from "@/lib/queries";
import { ApiError } from "@/lib/api";
import { formatRelative } from "@/lib/format";

type RunOn = "any" | "local" | "device";

export function AgentsPage() {
  const q = useQuery(agentsQuery());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
        <p className="text-sm text-muted-foreground">
          Reusable agent definitions (command + args + env). Linked to a flow's
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
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [runOn, setRunOn] = useState<RunOn>("any");
  const create = useCreateAgent();
  const error = create.error instanceof ApiError ? create.error.body : null;

  const args = parseArgs(argsText);
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
            placeholder="e.g. claude  /  node  /  /usr/local/bin/my-reviewer"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            className="font-mono text-xs"
          />
        </div>
        <div>
          <Label htmlFor="new-agent-args">Arguments (one per line)</Label>
          <Textarea
            id="new-agent-args"
            placeholder={"--print\n--model\nclaude-sonnet-4-6"}
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            className="min-h-20 font-mono text-xs"
          />
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
                { name: name.trim(), command: command.trim(), args, env, runOn },
                {
                  onSuccess: () => {
                    setName("");
                    setCommand("");
                    setArgsText("");
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
  const [name, setName] = useState(agent.name);
  const [command, setCommand] = useState(agent.command);
  const [argsText, setArgsText] = useState(agent.args.join("\n"));
  const [envText, setEnvText] = useState(
    Object.entries(agent.env).map(([k, v]) => `${k}=${v}`).join("\n"),
  );
  const [runOn, setRunOn] = useState<RunOn>(agent.runOn);
  const update = useUpdateAgent();
  const remove = useDeleteAgent();

  const reset = () => {
    setName(agent.name);
    setCommand(agent.command);
    setArgsText(agent.args.join("\n"));
    setEnvText(Object.entries(agent.env).map(([k, v]) => `${k}=${v}`).join("\n"));
    setRunOn(agent.runOn);
  };

  return (
    <Card>
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
                          args: parseArgs(argsText),
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
            </div>
            <div>
              <Label>Args (one per line)</Label>
              <Textarea
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                className="min-h-20 font-mono text-xs"
              />
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

function parseArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
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
