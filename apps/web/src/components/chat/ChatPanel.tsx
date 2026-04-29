import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { agentsQuery, type AgentRow } from "@/lib/queries";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useChatActions } from "@/lib/chatActions";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  agentRunId?: string;
  /** True while the assistant message is still streaming. */
  pending?: boolean;
}

interface PageContext {
  pathname: string;
  projectId?: string;
  flowSlug?: string;
  flowRunId?: string;
}

export function ChatPanel({ open, onClose }: Props) {
  const location = useLocation();
  const params = useParams();
  const agentsQ = useQuery(agentsQuery());
  const [agentId, setAgentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  // Stable per-panel-open session id so the agent can use --resume / --continue.
  const sessionIdRef = useRef<string>("");
  if (sessionIdRef.current === "") {
    sessionIdRef.current = `chat_${crypto.randomUUID()}`;
  }

  // Default-pick the first agent once they load.
  useEffect(() => {
    if (!agentId && agentsQ.data?.agents.length) {
      setAgentId(agentsQ.data.agents[0]!.id);
    }
  }, [agentId, agentsQ.data]);

  const pageContext: PageContext = useMemo(
    () => ({
      pathname: location.pathname,
      projectId: params.id ?? params.projectId,
      flowSlug: params.slug,
      flowRunId: params.runId,
    }),
    [location.pathname, params.id, params.projectId, params.slug, params.runId],
  );

  const send = async () => {
    const text = input.trim();
    if (!text || !agentId || sending) return;
    setSending(true);
    setInput("");

    const userMsg: Message = {
      id: `u_${Date.now()}`,
      role: "user",
      text,
    };
    const assistantId = `a_${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: assistantId, role: "assistant", text: "", pending: true },
    ]);

    const turnIndex = messages.filter((m) => m.role === "user").length + 1;
    try {
      const { agentRunId } = await api.post<{ agentRunId: string }>(
        "/api/chat/messages",
        {
          agentId,
          sessionId: sessionIdRef.current,
          turnIndex,
          message: text,
          pageContext,
        },
      );
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, agentRunId } : m)),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, text: `(error) ${msg}`, pending: false }
            : m,
        ),
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <aside
      className={cn(
        "fixed right-0 top-0 z-40 flex h-screen w-[28rem] flex-col border-l bg-card shadow-xl transition-transform",
        open ? "translate-x-0" : "translate-x-full",
      )}
      aria-hidden={!open}
    >
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Bot className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold tracking-tight">Chat with agent</span>
        <div className="ml-auto flex items-center gap-2">
          <Select
            value={agentId ?? ""}
            onValueChange={(v) => setAgentId(v)}
            disabled={!agentsQ.data?.agents.length}
          >
            <SelectTrigger className="h-8 w-44">
              <SelectValue placeholder="Pick agent" />
            </SelectTrigger>
            <SelectContent align="end">
              {agentsQ.data?.agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <EmptyState agents={agentsQ.data?.agents ?? []} pageContext={pageContext} />
        ) : (
          <div className="space-y-4">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
          </div>
        )}
      </div>

      <div className="border-t p-3">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={
            agentId
              ? "Ask for help with this page… (⌘/Ctrl+Enter to send)"
              : "Pick an agent above to start chatting"
          }
          className="min-h-20 resize-none text-sm"
          disabled={!agentId}
        />
        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>page: {shortPath(pageContext.pathname)}</span>
          <Button
            size="sm"
            disabled={!agentId || !input.trim() || sending}
            onClick={() => void send()}
          >
            <Send className="size-3.5" />
            Send
          </Button>
        </div>
      </div>
    </aside>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="ml-6 rounded-lg bg-secondary px-3 py-2 text-sm">
        {message.text}
      </div>
    );
  }
  return <AssistantBubble message={message} />;
}

function AssistantBubble({ message }: { message: Message }) {
  const { text } = useStreamedAssistant(message);
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="mr-6 space-y-2">
      <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm leading-relaxed">
        {blocks.map((b, i) =>
          b.kind === "text" ? (
            <p key={i} className="whitespace-pre-wrap break-words">
              {b.text || (message.pending ? "…" : "")}
            </p>
          ) : (
            <FencedBlock key={i} type={b.type} content={b.content} />
          ),
        )}
        {message.pending && text === "" && (
          <p className="text-xs text-muted-foreground">…</p>
        )}
      </div>
    </div>
  );
}

/**
 * Streams an assistant message's text from the agent_run_logs SSE. The text
 * field on the source `message` is only used as a fallback (e.g. error case
 * filled by the caller).
 *
 * On terminal "end", invalidate the resource keys the agent might have
 * mutated server-side. Earlier this called qc.invalidateQueries() with no
 * key — that nuked auth + every unrelated query and cascaded refetches into
 * any component that subscribed to the agents/prompts/etc lists.
 */
const CHAT_INVALIDATABLE_ROOTS: ReadonlySet<string> = new Set([
  "agents",
  "prompts",
  "projects",
  "flow-templates",
  "flow-runs",
  "devices",
  "activity",
  "runs",
]);

function useStreamedAssistant(message: Message): { text: string } {
  const [chunks, setChunks] = useState<string>("");
  const lastRunRef = useRef<string | null>(null);
  const qc = useQueryClient();

  useEffect(() => {
    setChunks("");
    if (!message.agentRunId) return;
    if (lastRunRef.current === message.agentRunId) return;
    lastRunRef.current = message.agentRunId;
    const es = new EventSource(
      `/api/runs/${message.agentRunId}/logs/stream`,
      { withCredentials: true },
    );
    es.addEventListener("log", (e: MessageEvent) => {
      try {
        const row = JSON.parse(e.data) as { stream: string; chunk: string };
        if (row.stream === "stdout") {
          setChunks((prev) => prev + row.chunk);
        }
      } catch {
        // ignore
      }
    });
    es.addEventListener("end", () => {
      es.close();
      void qc.invalidateQueries({
        predicate: (q) =>
          typeof q.queryKey[0] === "string" &&
          CHAT_INVALIDATABLE_ROOTS.has(q.queryKey[0]),
      });
    });
    es.onerror = () => {
      // Browsers auto-reconnect; do nothing.
    };
    return () => {
      es.close();
    };
  }, [message.agentRunId, qc]);

  return { text: message.text || chunks };
}

interface FencedBlockType {
  kind: "code";
  type: string;
  content: string;
}
interface TextBlockType {
  kind: "text";
  text: string;
}
type Block = FencedBlockType | TextBlockType;

/**
 * Parse a markdown-ish reply into alternating text and fenced-code blocks.
 * The fence's "info string" (after ```) becomes the action type.
 */
function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push({ kind: "text", text: text.slice(last, m.index) });
    }
    out.push({ kind: "code", type: m[1]!.trim() || "text", content: m[2]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push({ kind: "text", text: text.slice(last) });
  }
  return out;
}

function FencedBlock({ type, content }: { type: string; content: string }) {
  const { resolve, version } = useChatActions();
  // version dependency forces a re-render when actions register/unregister.
  void version;
  const handler = resolve(type);
  return (
    <div className="my-2 rounded-md border bg-background p-2">
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-mono">{type}</span>
        <div className="flex gap-1">
          {handler && (
            <Button size="sm" variant="default" onClick={() => handler(content)}>
              Apply as {type}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(content)}
          >
            Copy
          </Button>
        </div>
      </div>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
        {content}
      </pre>
    </div>
  );
}

function EmptyState({
  agents,
  pageContext,
}: {
  agents: AgentRow[];
  pageContext: PageContext;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
      <Bot className="size-8 opacity-50" />
      <p>
        Chat with one of your agents. The page you're on is sent along so the
        agent can offer setup suggestions.
      </p>
      <p className="text-xs">
        Page: <span className="font-mono">{shortPath(pageContext.pathname)}</span>
        {agents.length === 0 && " — define an agent first under /agents."}
      </p>
    </div>
  );
}

function shortPath(p: string): string {
  return p.length > 60 ? `${p.slice(0, 57)}…` : p;
}
