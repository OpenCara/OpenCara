import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { diffWordsWithSpace } from "diff";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Info, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

export interface CanvasContext {
  /** Project ID, threaded into pageContext.canvas.projectId on every send. */
  projectId: string;
  /** Issue number for /api/projects/:id/issues/:n. */
  issueNumber: number;
  /**
   * The text currently selected in the editor. Snapshotted onto each user
   * message at send-time so a later "Apply" still uses the right original.
   */
  selection: string | null;
  onClearSelection: () => void;
  /**
   * Optional. Called when the user accepts an agent rewrite. Receives the
   * original snapshotted selection and the assistant's full response.
   *
   * When omitted (the new path), the agent applies its own rewrite by
   * PATCHing the issue draft via /api/agent/.../body — there's no UI Apply
   * button, the diff appears in the issue body itself once the run ends
   * and the page refetches.
   */
  onApplyRewrite?: (original: string, replacement: string) => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** "floating" (default) = fixed-position sidebar with slide-in transition.
   * "embedded" = sized to parent column, no transition, no close button. */
  variant?: "floating" | "embedded";
  canvas?: CanvasContext;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  agentRunId?: string;
  /** True while the assistant message is still streaming. */
  pending?: boolean;
  /** Snapshot of the canvas selection at the moment THIS turn was sent.
   * Used to render an Apply button on the matching assistant reply. */
  attachedSelection?: string;
}

interface PageContext {
  /**
   * Stable page id the orchestrator's skill registry keys on (see
   * packages/orchestrator/src/flows/skills.ts). Derived from the URL +
   * any canvas prop. Pages without a registered skill leave this null
   * and the chat falls back to today's pathname-only behaviour.
   */
  page: string | null;
  pathname: string;
  projectId?: string;
  flowSlug?: string;
  flowRunId?: string;
  canvas?: {
    kind: "issue";
    projectId: string;
    issueNumber: number;
    selection: { text: string } | null;
  };
}

/**
 * URL-pattern → page id table. Each pattern matches exactly one page in
 * apps/web/src/App.tsx; new pages with skills register a new entry here
 * + a builder server-side. The canvas prop short-circuits to
 * "issue-canvas" so IssueDetailPage's embedded panel works the same
 * way the AppShell's global panel would on that route.
 */
const PAGE_PATTERNS: { pattern: RegExp; page: string }[] = [
  { pattern: /^\/projects\/[^/]+\/issues\/[^/]+$/, page: "issue-canvas" },
  { pattern: /^\/projects\/[^/]+\/flow-runs\/[^/]+$/, page: "flow-run-detail" },
  { pattern: /^\/projects\/[^/]+\/flows\/[^/]+$/, page: "project-flow-detail" },
  { pattern: /^\/flows\/[^/]+$/, page: "flow-template-detail" },
  // Project-detail covers `/projects/:id` AND `/projects/:id/:tab` — kept
  // last so the more-specific patterns above win first.
  { pattern: /^\/projects\/[^/]+(?:\/[^/]+)?$/, page: "project-detail" },
];

function pageForLocation(
  pathname: string,
  hasCanvas: boolean,
): string | null {
  if (hasCanvas) return "issue-canvas";
  for (const { pattern, page } of PAGE_PATTERNS) {
    if (pattern.test(pathname)) return page;
  }
  return null;
}

export function ChatPanel({ open, onClose, variant = "floating", canvas }: Props) {
  const location = useLocation();
  const params = useParams();
  const agentsQ = useQuery(agentsQuery());
  const [agentId, setAgentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);

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
      page: pageForLocation(location.pathname, !!canvas),
      pathname: location.pathname,
      projectId: params.id ?? params.projectId,
      flowSlug: params.slug,
      flowRunId: params.runId,
    }),
    [
      location.pathname,
      params.id,
      params.projectId,
      params.slug,
      params.runId,
      canvas,
    ],
  );

  const send = async () => {
    const text = input.trim();
    if (!text || !agentId || sending) return;
    setSending(true);
    setInput("");

    // Snapshot the canvas selection NOW (at send-time). The user can change
    // their selection while the agent is responding; we want Apply to use
    // the snippet they were looking at when they hit Send.
    const canvasSelection = canvas?.selection?.trim() || null;

    const userMsg: Message = {
      id: `u_${Date.now()}`,
      role: "user",
      text,
      attachedSelection: canvasSelection ?? undefined,
    };
    const assistantId = `a_${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      userMsg,
      {
        id: assistantId,
        role: "assistant",
        text: "",
        pending: true,
        attachedSelection: canvasSelection ?? undefined,
      },
    ]);

    const turnIndex = messages.filter((m) => m.role === "user").length + 1;
    const ctxForRequest: PageContext = canvas
      ? {
          ...pageContext,
          canvas: {
            kind: "issue",
            projectId: canvas.projectId,
            issueNumber: canvas.issueNumber,
            selection: canvasSelection ? { text: canvasSelection } : null,
          },
        }
      : pageContext;

    try {
      const { agentRunId } = await api.post<{ agentRunId: string }>(
        "/api/chat/messages",
        {
          agentId,
          sessionId: sessionIdRef.current,
          turnIndex,
          message: text,
          pageContext: ctxForRequest,
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

  const wrapperClasses =
    variant === "floating"
      ? cn(
          "fixed right-0 top-0 z-40 flex h-screen w-[28rem] flex-col border-l bg-card shadow-xl transition-transform",
          open ? "translate-x-0" : "translate-x-full",
        )
      : "flex h-full flex-col border-l bg-card";

  const Wrapper = variant === "floating" ? "aside" : "div";

  return (
    <Wrapper
      className={wrapperClasses}
      aria-hidden={variant === "floating" ? !open : undefined}
    >
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Bot className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold tracking-tight">
          {canvas ? "Edit with agent" : "Chat with agent"}
        </span>
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
          <Button
            size="sm"
            variant="ghost"
            title="What does the agent know about this page?"
            onClick={() => setSkillOpen(true)}
          >
            <Info className="size-4" />
          </Button>
          {variant === "floating" && (
            <Button size="sm" variant="ghost" onClick={onClose}>
              <X className="size-4" />
            </Button>
          )}
        </div>
      </div>

      <SkillDialog
        open={skillOpen}
        onOpenChange={setSkillOpen}
        pageContext={
          canvas
            ? {
                ...pageContext,
                canvas: {
                  kind: "issue",
                  projectId: canvas.projectId,
                  issueNumber: canvas.issueNumber,
                  selection: null,
                },
              }
            : pageContext
        }
      />

      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <EmptyState
            agents={agentsQ.data?.agents ?? []}
            pageContext={pageContext}
            canvas={canvas}
          />
        ) : (
          <div className="space-y-4">
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                onApplyRewrite={canvas?.onApplyRewrite}
              />
            ))}
          </div>
        )}
      </div>

      {canvas?.selection && (
        <div className="border-t bg-secondary/40 px-3 py-2">
          <div className="flex items-start gap-2 text-xs">
            <span className="mt-0.5 text-muted-foreground">selection:</span>
            <span className="flex-1 truncate font-mono">{canvas.selection}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={canvas.onClearSelection}
              className="h-6 px-1"
              title="Clear selection"
            >
              <X className="size-3" />
            </Button>
          </div>
        </div>
      )}

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
              ? canvas?.selection
                ? "How should this be rewritten? (⌘/Ctrl+Enter)"
                : "Ask for help with this page… (⌘/Ctrl+Enter to send)"
              : "Pick an agent above to start chatting"
          }
          className="min-h-20 resize-none text-sm"
          disabled={!agentId}
        />
        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>{canvas ? "canvas mode" : `page: ${shortPath(pageContext.pathname)}`}</span>
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
    </Wrapper>
  );
}

function MessageBubble({
  message,
  onApplyRewrite,
}: {
  message: Message;
  onApplyRewrite?: (original: string, replacement: string) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="ml-6 space-y-1">
        {message.attachedSelection && (
          <div className="rounded-md border bg-secondary/30 px-2 py-1 text-xs text-muted-foreground">
            <span className="mr-1 font-semibold">on:</span>
            <span className="font-mono">
              {previewText(message.attachedSelection, 120)}
            </span>
          </div>
        )}
        <div className="rounded-lg bg-secondary px-3 py-2 text-sm">{message.text}</div>
      </div>
    );
  }
  return <AssistantBubble message={message} onApplyRewrite={onApplyRewrite} />;
}

function AssistantBubble({
  message,
  onApplyRewrite,
}: {
  message: Message;
  onApplyRewrite?: (original: string, replacement: string) => void;
}) {
  const { text } = useStreamedAssistant(message);
  const blocks = useMemo(() => parseBlocks(text), [text]);
  // The "rewrite candidate" is only meaningful when this turn had a selection
  // attached. We strip fenced blocks from the rewrite text since the user's
  // selection was almost certainly plain prose; including code fences would
  // produce a ```-laden replacement.
  const rewriteCandidate = useMemo(() => {
    if (!message.attachedSelection) return null;
    return blocks
      .map((b) => (b.kind === "text" ? b.text : ""))
      .join("")
      .trim();
  }, [blocks, message.attachedSelection]);

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
      {!message.pending &&
        message.attachedSelection &&
        rewriteCandidate &&
        onApplyRewrite && (
          <RewritePreview
            original={message.attachedSelection}
            rewrite={rewriteCandidate}
            onApply={() =>
              onApplyRewrite(message.attachedSelection!, rewriteCandidate)
            }
          />
        )}
    </div>
  );
}

function RewritePreview({
  original,
  rewrite,
  onApply,
}: {
  original: string;
  rewrite: string;
  onApply: () => void;
}) {
  const [applied, setApplied] = useState(false);
  const parts = useMemo(() => diffWordsWithSpace(original, rewrite), [
    original,
    rewrite,
  ]);
  return (
    <div className="rounded-md border bg-background p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Rewrite preview
        </span>
        <Button size="sm" disabled={applied} onClick={() => { onApply(); setApplied(true); }}>
          {applied ? "Applied" : "Apply"}
        </Button>
      </div>
      <div className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
        {parts.map((part, i) => (
          <span
            key={i}
            className={cn(
              part.added && "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
              part.removed && "bg-red-500/20 text-red-700 line-through dark:text-red-300",
            )}
          >
            {part.value}
          </span>
        ))}
      </div>
    </div>
  );
}

function previewText(s: string, max: number): string {
  const trimmed = s.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
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
  canvas,
}: {
  agents: AgentRow[];
  pageContext: PageContext;
  canvas?: CanvasContext;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
      <Bot className="size-8 opacity-50" />
      {canvas ? (
        <>
          <p>
            Select text in the issue body, then ask the agent to rewrite it.
            The full issue (title, body, labels, assignees) is sent along for
            stylistic context.
          </p>
          <p className="text-xs">
            {agents.length === 0 && "Define an agent first under /agents."}
          </p>
        </>
      ) : (
        <>
          <p>
            Chat with one of your agents. The page you're on is sent along so
            the agent can offer setup suggestions.
          </p>
          <p className="text-xs">
            Page: <span className="font-mono">{shortPath(pageContext.pathname)}</span>
            {agents.length === 0 && " — define an agent first under /agents."}
          </p>
        </>
      )}
    </div>
  );
}

function shortPath(p: string): string {
  return p.length > 60 ? `${p.slice(0, 57)}…` : p;
}

interface SkillResponse {
  skill: { name: string; instructions: string } | null;
  hydratedKeys?: string[];
  projectScope?: string | null;
}

/**
 * Inspect-only view of the active page skill — what markdown the agent
 * receives on stdin for this page, plus the names of hydrated stdin
 * keys. Fetched on open so we always show the current state (the
 * registry is server-side; the panel doesn't otherwise know what was
 * sent to the agent).
 */
function SkillDialog({
  open,
  onOpenChange,
  pageContext,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  pageContext: PageContext;
}) {
  const q = useQuery({
    queryKey: ["chat-skill", pageContext.page, pageContext.pathname],
    enabled: open,
    queryFn: () => api.post<SkillResponse>("/api/chat/skill", { pageContext }),
    // Keep one minute of cache so reopening the dialog mid-session is
    // instant; the markdown only changes when the schema/builder ships.
    staleTime: 60_000,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Skill for{" "}
            <span className="font-mono text-sm">
              {pageContext.page ?? "(unregistered page)"}
            </span>
          </DialogTitle>
          <DialogDescription>
            What the agent receives on stdin for this page. Source:{" "}
            <span className="font-mono">
              packages/orchestrator/src/flows/skills/
            </span>
          </DialogDescription>
        </DialogHeader>
        {q.isLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {q.isError && (
          <p className="text-sm text-destructive">
            Failed to load skill: {(q.error as Error).message}
          </p>
        )}
        {q.data && !q.data.skill && (
          <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
            No skill registered for this page. The agent receives only the
            base envelope (message, pageContext, history) — same as before
            this feature shipped.
          </div>
        )}
        {q.data?.skill && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-md border px-2 py-1 font-mono">
                {q.data.skill.name}
              </span>
              {q.data.projectScope && (
                <span className="rounded-md border bg-muted px-2 py-1 text-muted-foreground">
                  project scope: {q.data.projectScope}
                </span>
              )}
              {q.data.hydratedKeys && q.data.hydratedKeys.length > 0 && (
                <span className="text-muted-foreground">
                  stdin keys:{" "}
                  {q.data.hydratedKeys.map((k) => (
                    <span
                      key={k}
                      className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono"
                    >
                      {k}
                    </span>
                  ))}
                </span>
              )}
            </div>
            <div className="prose prose-sm max-h-[60vh] max-w-none overflow-y-auto rounded-md border bg-background p-3 dark:prose-invert">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {q.data.skill.instructions}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
