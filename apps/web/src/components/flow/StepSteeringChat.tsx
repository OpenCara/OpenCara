import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, Loader2, MessageSquare, Send, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  agentsQuery,
  chatSessionQuery,
  useChatSessionAgentMutation,
  type ChatSessionScope,
} from "@/lib/queries";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Props {
  /** flow_run_steps.id — drives the (user, 'flow_run_step', stepId) chat row. */
  flowRunStepId: string;
  /** project id for the page context envelope; gates skill resolution server-side. */
  projectId: string;
  /** flow_run id for the page context envelope. */
  flowRunId: string;
  /** Human label of the step ("Step 2 · agent" → shown in the header). */
  stepLabel?: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  agentRunId?: string;
  pending?: boolean;
  endStatus?: string;
}

/**
 * Embedded chat for a single agent node in a flow run. Reuses the
 * regular /api/chat/messages backend with the new flow_run_step scope;
 * server-side hydration in chatSessions.ts pre-seeds the chat row with
 * the agent's ACP session id so the first user message resumes the
 * conversation the flow agent had.
 *
 * Deliberately simpler than the sidebar ChatPanel — no permission mode
 * toggle, no history popover, no skill inspector. Steering is a focused
 * "send a course correction" interaction; the heavyweight chat surface
 * stays available in the sidebar for project-wide questions.
 */
export function StepSteeringChat({
  flowRunStepId,
  projectId,
  flowRunId,
  stepLabel,
}: Props) {
  const scope: ChatSessionScope = useMemo(
    () => ({ scopeKind: "flow_run_step", scopeId: flowRunStepId }),
    [flowRunStepId],
  );
  const sessionQ = useQuery(chatSessionQuery(scope));
  const agentsQ = useQuery(agentsQuery());
  const updateAgent = useChatSessionAgentMutation(scope);

  const session = sessionQ.data?.session ?? null;
  const sessionAgentId = session?.agentId ?? null;
  const [agentId, setAgentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  // Once the session loads, sync our local agentId to the persisted pick.
  // Fall back to the first available agent if neither the seed nor the
  // user has chosen one (e.g. the flow ran with a one-off command-line
  // agent that doesn't correspond to an agents-table row).
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current || !sessionQ.data) return;
    hydratedRef.current = true;
    if (sessionAgentId) {
      setAgentId(sessionAgentId);
      return;
    }
    const first = agentsQ.data?.agents[0]?.id ?? null;
    if (first) {
      setAgentId(first);
      updateAgent.mutate({ agentId: first });
    }
  }, [sessionQ.data, sessionAgentId, agentsQ.data, updateAgent]);

  // Each render this is recomputed off `messages` — the streaming
  // bubble is the latest assistant message that hasn't ended.
  const streamingMessage = messages.findLast(
    (m) => m.role === "assistant" && m.pending && m.agentRunId,
  );
  const streamingRunId = streamingMessage?.agentRunId ?? null;
  const isStreaming = streamingRunId !== null;

  const stop = async () => {
    if (!streamingRunId) return;
    try {
      await api.post(`/api/chat/messages/${streamingRunId}/cancel`, {});
    } catch {
      // 409 = already terminal; SSE end event still settles the bubble.
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !agentId || sending || !session) return;
    setSending(true);
    setInput("");

    const userMsg: Message = { id: `u_${Date.now()}`, role: "user", text };
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
          sessionId: session.threadKey,
          turnIndex,
          message: text,
          pageContext: {
            page: "flow-run-step-chat",
            pathname: `/projects/${projectId}/flow-runs/${flowRunId}`,
            projectId,
            flowRunId,
            flowRunStepId,
          },
          // Local history — the server also injects the agent's ACP
          // session via priorSessionId, so this is just a fallback for
          // when resume isn't available (different device, etc.).
          history: messages
            .filter((m) => !m.pending && m.text.trim().length > 0)
            .map((m) => ({ role: m.role, text: m.text })),
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

  const onAgentPick = (next: string) => {
    if (next === agentId) return;
    setAgentId(next);
    updateAgent.mutate({ agentId: next });
    // Switching agents on a step-scoped chat invalidates the seeded ACP
    // session anyway (the server clears acpSessionId on agent change in
    // chatSessions.ts POST). Local message list is conversational state
    // only — clear it so the user doesn't see stale exchanges attributed
    // to the wrong agent.
    if (messages.length > 0) setMessages([]);
  };

  const handleStreamEnd = (id: string, status: string, finalText?: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id
          ? {
              ...m,
              text: finalText || m.text,
              pending: false,
              ...(status !== "succeeded" ? { endStatus: status } : {}),
            }
          : m,
      ),
    );
  };

  return (
    <div className="rounded-md border bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <MessageSquare className="size-4 text-muted-foreground" />
        <div className="flex flex-col">
          <span className="text-sm font-medium">
            Steer this agent{stepLabel ? ` · ${stepLabel}` : ""}
          </span>
          <span className="text-[10px] text-muted-foreground">
            Resumes the agent's session. Mid-run: queued until the next turn.
          </span>
        </div>
        {isStreaming && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
            <Loader2 className="size-3 animate-spin" /> streaming
          </span>
        )}
      </div>

      <div className="max-h-72 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <EmptyState hasAgents={(agentsQ.data?.agents.length ?? 0) > 0} />
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <Bubble key={m.id} message={m} onStreamEnd={handleStreamEnd} />
            ))}
          </div>
        )}
      </div>

      <div className="border-t p-3">
        <div className="mb-2 flex items-center gap-2 text-xs">
          <label className="text-muted-foreground">agent:</label>
          <select
            value={agentId ?? ""}
            disabled={!agentsQ.data?.agents.length}
            onChange={(e) => onAgentPick(e.target.value)}
            className="h-7 rounded border bg-background px-1 text-xs"
          >
            <option value="" disabled>
              pick agent
            </option>
            {agentsQ.data?.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
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
            !session
              ? "Loading session…"
              : agentId
                ? "Send a steering message… (⌘/Ctrl+Enter)"
                : "Pick an agent above to start chatting"
          }
          className="min-h-16 resize-none text-sm"
          disabled={!agentId || !session}
        />
        <div className="mt-2 flex justify-end">
          {isStreaming ? (
            <Button size="sm" variant="destructive" onClick={() => void stop()}>
              <Square className="size-3.5" /> Stop
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!agentId || !input.trim() || sending || !session}
              onClick={() => void send()}
            >
              <Send className="size-3.5" /> Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ hasAgents }: { hasAgents: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1 text-center text-xs text-muted-foreground">
      <Bot className="size-6 opacity-50" />
      <p>No steering messages yet for this step.</p>
      {!hasAgents && (
        <p>Define an agent first under /agents to be able to chat.</p>
      )}
    </div>
  );
}

function Bubble({
  message,
  onStreamEnd,
}: {
  message: Message;
  onStreamEnd: (id: string, status: string, finalText?: string) => void;
}) {
  const streamed = useStreamedAssistant(message, onStreamEnd);
  if (message.role === "user") {
    return (
      <div className="ml-6">
        <div className="rounded-lg bg-secondary px-3 py-2 text-sm">
          <pre className="whitespace-pre-wrap break-words font-sans">
            {message.text}
          </pre>
        </div>
      </div>
    );
  }
  return (
    <div className="mr-6">
      <div
        className={cn(
          "rounded-lg border bg-muted/30 px-3 py-2 text-sm leading-relaxed",
        )}
      >
        <pre className="whitespace-pre-wrap break-words font-sans">
          {streamed || (message.pending ? "…" : "")}
        </pre>
        {message.endStatus && (
          <p
            className={cn(
              "mt-1 inline-block rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
              message.endStatus === "cancelled"
                ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                : "bg-red-500/15 text-red-700 dark:text-red-300",
            )}
          >
            {message.endStatus}
          </p>
        )}
      </div>
    </div>
  );
}

function useStreamedAssistant(
  message: Message,
  onEnd: (id: string, status: string, finalText?: string) => void,
): string {
  const [chunks, setChunks] = useState<string>("");
  const chunksRef = useRef<string>("");
  const lastRunRef = useRef<string | null>(null);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => {
    setChunks("");
    chunksRef.current = "";
    if (!message.agentRunId) return;
    if (lastRunRef.current === message.agentRunId) return;
    lastRunRef.current = message.agentRunId;
    const es = new EventSource(`/api/runs/${message.agentRunId}/logs/stream`, {
      withCredentials: true,
    });
    es.addEventListener("log", (e: MessageEvent) => {
      try {
        const row = JSON.parse(e.data) as { stream: string; chunk: string };
        if (row.stream === "stdout") {
          setChunks((prev) => {
            const next = prev + row.chunk;
            chunksRef.current = next;
            return next;
          });
        }
      } catch {
        // ignore parse error
      }
    });
    es.addEventListener("end", (e: MessageEvent) => {
      es.close();
      let status = "succeeded";
      try {
        const parsed = JSON.parse(e.data) as { status?: string };
        if (typeof parsed.status === "string") status = parsed.status;
      } catch {
        // ignore
      }
      onEndRef.current(message.id, status, chunksRef.current);
    });
    es.onerror = () => {
      // browsers auto-reconnect; do nothing
    };
    return () => {
      es.close();
    };
  }, [message.agentRunId, message.id]);

  return message.text || chunks;
}
