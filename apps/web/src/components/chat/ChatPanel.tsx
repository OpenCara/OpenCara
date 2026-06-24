import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import { useLocation, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/common";
import { ChatMarkdown } from "./ChatMarkdown";
import {
  Archive,
  ArchiveRestore,
  Bot,
  Brain,
  ImagePlus,
  Info,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Send,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
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
import {
  agentsQuery,
  chatSessionListQuery,
  chatSessionQuery,
  useChatSessionAgentMutation,
  useDeleteChatSession,
  useNewChatSession,
  useRenameChatSession,
  useRestoreChatSession,
  type AgentRow,
  type ChatSession,
  type ChatSessionScope,
} from "@/lib/queries";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useChatActions } from "@/lib/chatActions";
import { useShowThinking } from "./preferences";

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Text currently selected on the page. Snapshotted onto each user
   * message at send-time so a later context reference uses the right
   * original. Managed by the AppShell's SelectionToolbar.
   */
  selection?: string | null;
  onClearSelection?: () => void;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  agentRunId?: string;
  /** True while the assistant message is still streaming. */
  pending?: boolean;
  /** Non-success terminal status (`failed` | `cancelled`) surfaced from
   * the run's SSE end event. Drives a small tag on the bubble so a
   * cancelled or errored turn is visually distinct from a clean answer.
   * Unset for in-flight or successful runs. */
  endStatus?: string;
  /** Snapshot of the canvas selection at the moment THIS turn was sent.
   * Used to render an Apply button on the matching assistant reply. */
  attachedSelection?: string;
  /** Data URLs of images attached to a user turn. Rendered inline in the
   * bubble so the conversation history shows what was sent. */
  images?: string[];
}

/**
 * An image staged in the composer before send — captured from a
 * clipboard paste or a drag-and-drop. `dataUrl` is the full
 * `data:<mime>;base64,<payload>` form (used for the thumbnail preview and,
 * after send, for inline rendering); `mimeType` is split out so the
 * send-time payload can ship the bare base64 + type the agent expects.
 */
interface PendingImage {
  id: string;
  dataUrl: string;
  mimeType: string;
  name?: string;
}

// Composer attachment limits — kept in lockstep with the orchestrator's
// chat route (`normalizeImages`). The client enforces them up front so
// oversized files never hit the wire, and the server re-checks so a
// crafted request can't bypass them.
const MAX_IMAGES_PER_TURN = 8;
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
// Mirror of the server's `ALLOWED_IMAGE_MIME`. The client MUST agree with
// it: staging a type the server drops (e.g. HEIC/AVIF/SVG) would preview
// + optimistically render an image the agent never receives. SVG is
// excluded deliberately — it's an XSS vector the server rightly refuses.
const ACCEPTED_IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;
// `accept` for the file picker — the same set, spelled for the OS dialog.
const ACCEPTED_IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

/** Read an image File/Blob into a `data:` URL, or null if it can't be read. */
function readImageFile(file: File): Promise<PendingImage | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl.startsWith("data:")) {
        resolve(null);
        return;
      }
      resolve({
        id: crypto.randomUUID(),
        dataUrl,
        mimeType: file.type || "image/png",
        name: file.name || undefined,
      });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** Strip the `data:<mime>;base64,` prefix, returning the bare base64 payload. */
function base64Payload(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

interface PageContext {
  /**
   * Stable page id the orchestrator's skill registry keys on (see
   * packages/orchestrator/src/flows/skills.ts). Derived from the URL.
   * Pages without a registered skill leave this null and the chat
   * falls back to today's pathname-only behaviour.
   */
  page: string | null;
  pathname: string;
  projectId?: string;
  issueNumber?: number;
  flowSlug?: string;
  flowRunId?: string;
  /** Generic text selection from the page, sent on every page type. */
  selection?: { text: string } | null;
  /** Issue-specific canvas context; only populated on issue pages. */
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
 * + a builder server-side.
 */
const PAGE_PATTERNS: { pattern: RegExp; page: string }[] = [
  { pattern: /^\/projects\/[^/]+\/issues\/[^/]+$/, page: "issue-canvas" },
  { pattern: /^\/projects\/[^/]+\/flow-runs\/[^/]+$/, page: "flow-run-detail" },
  { pattern: /^\/projects\/[^/]+\/flows\/[^/]+$/, page: "project-flow-detail" },
  { pattern: /^\/flows\/[^/]+$/, page: "flow-template-detail" },
  // Board (kanban) PM panel. Since #140 the board is the default tab at
  // the project base path, so the PM panel binds to `/projects/:id` (no
  // tab). Must come before the project-detail catch-all.
  { pattern: /^\/projects\/[^/]+$/, page: "project-pm" },
  // Project-detail covers the remaining `/projects/:id/:tab` URLs — kept
  // last so the more-specific patterns above win first.
  { pattern: /^\/projects\/[^/]+(?:\/[^/]+)?$/, page: "project-detail" },
];

function pageForLocation(pathname: string): string | null {
  for (const { pattern, page } of PAGE_PATTERNS) {
    if (pattern.test(pathname)) return page;
  }
  return null;
}

/**
 * Map a (pageId, params) pair to the `chat_sessions` scope that should
 * back this panel's conversation thread. Returns null when the page has
 * no scope to persist against (unregistered routes, or scoped pages
 * whose URL params haven't resolved yet) — caller falls back to a
 * per-panel-open ephemeral session id.
 *
 * The mapping intentionally collapses every project-scoped page onto a
 * single `(user, 'project', projectId)` thread so navigating between
 * kanban / flow detail / issue canvas inside one project picks up the
 * same conversation; the per-page skill injection handles "what is
 * the agent looking at right now."
 */
function scopeForPage(
  pageId: string | null,
  params: Readonly<Record<string, string | undefined>>,
): ChatSessionScope | null {
  if (!pageId) return null;
  if (pageId === "flow-template-detail") {
    const slug = params.slug;
    return slug ? { scopeKind: "template", scopeId: slug } : null;
  }
  // Every other registered page is project-scoped.
  const projectId = params.id ?? params.projectId;
  return projectId ? { scopeKind: "project", scopeId: projectId } : null;
}

const NO_SCOPE: ChatSessionScope = { scopeKind: "user", scopeId: "" };

// Per-turn permission knob forwarded to the agent runner. "default" =
// omit the field (agent's baked-in behaviour wins). "plan" is the most
// frequently used non-default value, hence the dedicated toggle button.
type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
const PERMISSION_MODE_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan" },
  { value: "bypassPermissions", label: "Bypass" },
];

export function ChatPanel({ open, onClose, selection, onClearSelection }: Props) {
  const location = useLocation();
  const params = useParams();
  const agentsQ = useQuery(agentsQuery());
  const [agentId, setAgentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [sending, setSending] = useState(false);
  const [answeredOptionMessageIds, setAnsweredOptionMessageIds] = useState<
    Set<string>
  >(() => new Set());
  const [skillOpen, setSkillOpen] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [showThinking, setShowThinking] = useShowThinking();
  // Collapsible session sidebar (issue #143) — replaces the old History
  // dialog. Open by default so the session list is visible alongside the
  // chat; the user can collapse it to reclaim width for the conversation.
  const [sessionPanelOpen, setSessionPanelOpen] = useState(true);
  // When the user picks a session from the sidebar, the panel pivots onto
  // that row instead of the "active" (most-recent-non-archived) one the
  // GET /chat/sessions resolver returns. Cleared when the scope changes;
  // otherwise sticks until the user picks a different row or starts a new
  // chat.
  const [overrideSession, setOverrideSession] = useState<ChatSession | null>(
    null,
  );

  const pageContext: PageContext = useMemo(
    () => ({
      page: pageForLocation(location.pathname),
      pathname: location.pathname,
      projectId: params.id ?? params.projectId,
      issueNumber: params.number
        ? Number.parseInt(params.number, 10)
        : undefined,
      flowSlug: params.slug,
      flowRunId: params.runId,
    }),
    [
      location.pathname,
      params.id,
      params.projectId,
      params.number,
      params.slug,
      params.runId,
    ],
  );

  // Auto-load (or lazy-create) the chat_sessions row for this scope.
  // `wantPersistence` gates both the network call and the Send button: if
  // the user fires a message before the session resolves, it would land
  // on a random sentinel id and break thread continuity. When the page
  // has no scope (unregistered route), skip persistence entirely and
  // fall back to a per-panel-open ephemeral session id.
  const scope = useMemo(
    () => scopeForPage(pageContext.page, params),
    [pageContext.page, params],
  );
  const wantPersistence = scope !== null;
  const sessionQ = useQuery({
    ...chatSessionQuery(scope ?? NO_SCOPE),
    enabled: wantPersistence,
  });
  const updateAgent = useChatSessionAgentMutation(scope ?? NO_SCOPE);
  const newSessionMut = useNewChatSession(scope ?? NO_SCOPE);
  const renameSessionMut = useRenameChatSession(scope ?? NO_SCOPE);
  const deleteSessionMut = useDeleteChatSession(scope ?? NO_SCOPE);
  const restoreSessionMut = useRestoreChatSession(scope ?? NO_SCOPE);
  const listQ = useQuery({
    ...chatSessionListQuery(scope ?? NO_SCOPE),
    enabled: wantPersistence && open && sessionPanelOpen,
    // Poll while the sidebar is visible so the Running/History split and
    // the pulsing indicators track agent runs that start or finish
    // out-of-band (e.g. a flow run streaming into this scope's session).
    refetchInterval: wantPersistence && open && sessionPanelOpen ? 5000 : false,
  });

  // Per-panel-open ephemeral session id for pages without a scope.
  // Lazily generated on first render and never updated — only consulted
  // when wantPersistence is false.
  const ephemeralSessionIdRef = useRef<string>("");
  if (ephemeralSessionIdRef.current === "") {
    ephemeralSessionIdRef.current = `chat_${crypto.randomUUID()}`;
  }
  // Hidden <input type=file> driven by the attach button — gives a
  // discoverable, click-to-pick path alongside paste / drag-and-drop.
  const fileInputRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave both bubble and fire as the cursor crosses child
  // elements, so a naive boolean flickers the overlay. Count enter/leave
  // pairs and only hide once the depth returns to zero (the cursor has
  // truly left the panel).
  const dragDepthRef = useRef(0);
  // The session id the panel actually dispatches against. Override wins
  // when the user explicitly picked one from History; otherwise the
  // server-resolved active session for the scope; otherwise a per-mount
  // ephemeral id for pages without persistence.
  const effectiveSessionId = wantPersistence
    ? overrideSession?.threadKey ?? sessionQ.data?.session.threadKey ?? null
    : ephemeralSessionIdRef.current;
  // The chat_sessions row id the panel is currently viewing (override wins
  // over the scope's resolved active row). Agent-pick persistence must
  // target THIS row, not the scope's most-recent active one — since #143 a
  // scope can hold several non-archived sessions at once.
  const effectiveSessionRowId =
    overrideSession?.id ?? sessionQ.data?.session.id ?? null;

  // Initialize the agent pick from the persisted session once it loads.
  // Falls back to the first available agent for ephemeral / fresh sessions.
  //
  // `hydratedAgentRef` is reset whenever `scope` changes so navigating from
  // project A to project B (same mounted ChatPanel, different scope object)
  // re-runs the hydration with the new project's persisted agent. Without the
  // reset, the ref stays `true` from the previous scope and the effect
  // short-circuits on every render — the new project's agent is never applied.
  const hydratedAgentRef = useRef(false);
  const prevScopeRef = useRef(scope);
  if (prevScopeRef.current !== scope) {
    prevScopeRef.current = scope;
    hydratedAgentRef.current = false;
    // Drop the manual session override on scope change — overrides are
    // a within-scope pivot; navigating to a different project should
    // pick that project's natural active session, not stay pinned to
    // some unrelated thread the user clicked earlier.
    setOverrideSession(null);
  }
  useEffect(() => {
    if (hydratedAgentRef.current) return;
    if (wantPersistence) {
      if (!sessionQ.data) return;
      hydratedAgentRef.current = true;
      const stored = sessionQ.data.session.agentId;
      if (stored) {
        setAgentId(stored);
        return;
      }
    }
    if (!agentId && agentsQ.data?.agents.length) {
      hydratedAgentRef.current = true;
      const first = agentsQ.data.agents[0]!.id;
      setAgentId(first);
      // Persist the auto-pick so the chat_sessions row has a non-null
      // agentId. chat.ts post-dispatch writes `acp_session_id` under
      // `where agentId = $requestAgentId`, which silently matches zero
      // rows when the persisted agent is still NULL — i.e. the
      // most-common golden path (first-ever chat on a scope, server
      // creates the row with agentId=null, client auto-picks the first
      // agent without POSTing it) never gets resume continuity.
      if (wantPersistence) {
        // During hydration there's no override yet, so the active row is
        // the scope's resolved session; pass its id explicitly anyway.
        updateAgent.mutate({
          agentId: first,
          sessionId: sessionQ.data?.session.id ?? null,
        });
      }
    }
  }, [wantPersistence, sessionQ.data, agentsQ.data, agentId, updateAgent]);

  const onAgentPick = (v: string) => {
    if (v === agentId) return;
    // Switching agent invalidates the resumable ACP session for this
    // thread (the new shim has no JSONL under the prior UUID). Warn
    // before throwing away an in-progress conversation — the server
    // will clear acpSessionId on the next agent POST anyway, so the
    // next turn starts fresh either way; the dialog just protects the
    // user from doing it accidentally.
    if (messages.length > 0) {
      const prior = agentsQ.data?.agents.find((a) => a.id === agentId)?.name;
      const next = agentsQ.data?.agents.find((a) => a.id === v)?.name ?? v;
      const proceed = window.confirm(
        `Switch to "${next}"?\n\n` +
          `This starts a new conversation — ${prior ?? "the current agent"}'s ` +
          `session can't be resumed by a different agent, so the prior turns ` +
          `won't be in context anymore.`,
      );
      if (!proceed) return;
      setMessages([]);
      setAnsweredOptionMessageIds(new Set());
    }
    setAgentId(v);
    if (wantPersistence)
      updateAgent.mutate({ agentId: v, sessionId: effectiveSessionRowId });
  };

  // The pending assistant turn currently streaming, if any. Stop is
  // only meaningful while a run is in flight; the streaming pill in
  // the header derives from the same value.
  const streamingMessage = useMemo(
    () =>
      messages.findLast(
        (m) => m.role === "assistant" && m.pending && m.agentRunId,
      ),
    [messages],
  );
  const streamingRunId = streamingMessage?.agentRunId ?? null;
  const isStreaming = streamingRunId !== null;

  // Flip pending=false on the matching message once its SSE end event
  // arrives. The status is informational (succeeded / failed / cancelled)
  // — we surface a tag on the bubble for non-success outcomes so the
  // user can tell apart "agent answered" from "agent was stopped".
  // Also captures the final streamed text so subsequent turns can send
  // it as conversation history (fallback when session resume isn't
  // available).
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

  const stop = async () => {
    if (!streamingRunId) return;
    try {
      await api.post(`/api/chat/messages/${streamingRunId}/cancel`, {});
    } catch (err) {
      // Non-fatal: the run may have ended in the same instant the
      // user clicked Stop, in which case the server returns 409. The
      // SSE end event still settles the bubble either way.
      console.warn("[chat] cancel failed", err);
    }
  };

  // Ingest image files from a paste or drop. Non-image files are
  // ignored; oversized ones are skipped; the staged set is capped at
  // MAX_IMAGES_PER_TURN so the composer can't grow unbounded.
  const addImageFiles = async (files: Iterable<File>) => {
    const candidates = Array.from(files).filter(
      (f) => ACCEPTED_IMAGE_MIME.test(f.type) && f.size <= MAX_IMAGE_BYTES,
    );
    if (candidates.length === 0) return;
    const read = (await Promise.all(candidates.map(readImageFile))).filter(
      (img): img is PendingImage => img !== null,
    );
    if (read.length === 0) return;
    setImages((prev) => [...prev, ...read].slice(0, MAX_IMAGES_PER_TURN));
  };

  const removeImage = (id: string) =>
    setImages((prev) => prev.filter((img) => img.id !== id));

  const onPaste = (e: ReactClipboardEvent) => {
    const items = e.clipboardData.items;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.kind === "file" && ACCEPTED_IMAGE_MIME.test(item.type)) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    // Only swallow the paste when it actually carried a supported image —
    // a normal text paste (or an unsupported image type) must still land
    // in the textarea / fall through to default handling untouched.
    if (files.length > 0) {
      e.preventDefault();
      void addImageFiles(files);
    }
  };

  const onDrop = (e: ReactDragEvent) => {
    dragDepthRef.current = 0;
    setDragActive(false);
    if (e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    void addImageFiles(e.dataTransfer.files);
  };

  const send = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    // Option-button replies (overrideText set) never carry composer
    // images — those belong to the user's own typed turn. A normal send
    // is valid with text OR at least one staged image.
    const imagesToSend = overrideText === undefined ? images : [];
    if (
      (!text && imagesToSend.length === 0) ||
      !agentId ||
      sending ||
      !effectiveSessionId
    )
      return;
    setSending(true);
    if (overrideText === undefined) {
      setInput("");
      setImages([]);
    }

    // Snapshot the selection NOW (at send-time). The user can change
    // their selection while the agent is responding; we want the context
    // to use the snippet they were looking at when they hit Send.
    const selectionSnapshot = selection?.trim() || null;

    const userMsg: Message = {
      id: `u_${Date.now()}`,
      role: "user",
      text,
      attachedSelection: selectionSnapshot ?? undefined,
      images:
        imagesToSend.length > 0
          ? imagesToSend.map((img) => img.dataUrl)
          : undefined,
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
        attachedSelection: selectionSnapshot ?? undefined,
      },
    ]);

    const turnIndex = messages.filter((m) => m.role === "user").length + 1;

    // Always include the selection in the generic pageContext.selection
    // field so the backend receives it on every page type. On issue
    // pages, also attach the canvas context for issue-specific ops.
    const isIssuePage = pageContext.page === "issue-canvas";
    const selObj = selectionSnapshot ? { text: selectionSnapshot } : null;
    const ctxForRequest: PageContext =
      isIssuePage && pageContext.projectId && pageContext.issueNumber
        ? {
            ...pageContext,
            selection: selObj,
            canvas: {
              kind: "issue",
              projectId: pageContext.projectId,
              issueNumber: pageContext.issueNumber,
              selection: selObj,
            },
          }
        : { ...pageContext, selection: selObj };

    // Build history from completed turns so the backend can inject them
    // as a fallback when session resume isn't available (e.g. MCP poison
    // cleared the prior session, or the session JSONL is on another
    // device). `messages` in this closure is the state BEFORE the new
    // user message was appended, so it contains only prior turns.
    // Capped to the last 20 turns to avoid unbounded POST bodies and
    // pushing the prompt toward token limits on long conversations.
    const allHistory = messages
      .filter((m) => !m.pending && m.text.trim().length > 0)
      .map((m) => ({
        role: m.role,
        text: m.role === "assistant" ? stripInternalMarkers(m.text) : m.text,
      }));
    const history = allHistory.slice(-20);

    try {
      const { agentRunId } = await api.post<{ agentRunId: string }>(
        "/api/chat/messages",
        {
          agentId,
          sessionId: effectiveSessionId,
          turnIndex,
          message: text,
          pageContext: ctxForRequest,
          history,
          // Bare base64 + mime per attachment — the orchestrator rebuilds
          // these into ACP image content blocks for the agent prompt.
          ...(imagesToSend.length > 0
            ? {
                images: imagesToSend.map((img) => ({
                  data: base64Payload(img.dataUrl),
                  mimeType: img.mimeType,
                })),
              }
            : {}),
          // Only send when explicitly non-default — the orchestrator
          // already treats omitted/default identically, but keeping
          // the request body minimal makes the dev console easier to
          // skim during troubleshooting.
          ...(permissionMode !== "default" ? { permissionMode } : {}),
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

  const selectOption = (messageId: string, value: string) => {
    setAnsweredOptionMessageIds((prev) => new Set(prev).add(messageId));
    void send(value);
  };

  return (
    <aside
      className={cn(
        "fixed right-0 top-0 z-40 flex h-screen flex-row border-l bg-card shadow-xl transition-transform",
        wantPersistence && sessionPanelOpen ? "w-[42rem]" : "w-[28rem]",
        open ? "translate-x-0" : "translate-x-full",
      )}
      aria-hidden={!open}
      onDragEnter={(e) => {
        // Only react to drags that carry files (an image drop), not
        // text selections being dragged around the page.
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        dragDepthRef.current += 1;
        setDragActive(true);
      }}
      onDragOver={(e) => {
        // preventDefault marks this as a valid drop target. Gate on the
        // payload (Files), not on `dragActive` — the latter is set async
        // by onDragEnter, so the first dragover would read it stale and
        // the browser could reject the drop.
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
        }
      }}
      onDragLeave={() => {
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragActive(false);
      }}
      onDrop={onDrop}
    >
      {wantPersistence && sessionPanelOpen && (
        <SessionPanel
          sessions={listQ.data?.sessions ?? []}
          activeSessionId={
            overrideSession?.id ?? sessionQ.data?.session.id ?? null
          }
          loading={listQ.isLoading}
          onCollapse={() => setSessionPanelOpen(false)}
          onNewChat={async () => {
            // archivePrevious:false — leave the prior conversation in the
            // sidebar's History group instead of archiving it away.
            const result = await newSessionMut.mutateAsync({
              agentId,
              archivePrevious: false,
            });
            setOverrideSession(result.session);
            setMessages([]);
            setAnsweredOptionMessageIds(new Set());
          }}
          onPick={(s) => {
            // Switching is non-destructive: we only re-point the panel at a
            // different thread; any in-flight agent run keeps streaming on
            // its own session untouched.
            setOverrideSession(s);
            setMessages([]);
            setAnsweredOptionMessageIds(new Set());
            // Hydrate the agent dropdown to whatever that session was last
            // run with — so the panel doesn't dispatch the user's current
            // agent into someone else's prior ACP thread.
            if (s.agentId) setAgentId(s.agentId);
          }}
          onRename={(id, title) => renameSessionMut.mutate({ id, title })}
          onDelete={(id) => deleteSessionMut.mutate({ id })}
          onRestore={(id) => restoreSessionMut.mutate({ id })}
          onHardDelete={async (id) => {
            // Permanent removal: drops the chat_sessions row AND its
            // associated agent_runs/history server-side (hard=1). Unlike
            // archive this is irreversible, so the row leaves the sidebar
            // entirely on the next list refetch.
            //
            // Await the result before touching panel state: the server
            // rejects (409) a session with an in-flight run, and we must
            // not clear the conversation the user is still watching when
            // the delete didn't actually happen.
            try {
              await deleteSessionMut.mutateAsync({ id, hard: true });
            } catch (err) {
              const msg =
                err instanceof ApiError &&
                err.body &&
                typeof err.body === "object" &&
                "error" in err.body
                  ? String((err.body as { error: unknown }).error)
                  : "Failed to delete session.";
              window.alert(msg);
              return;
            }
            // If we just deleted the thread the panel is viewing, pivot
            // off it so we don't keep dispatching against a dead session.
            if (id === effectiveSessionRowId) {
              setOverrideSession(null);
              setMessages([]);
              setAnsweredOptionMessageIds(new Set());
            }
          }}
        />
      )}

      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-primary/10 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-primary/60 bg-card/90 px-6 py-4 text-sm font-medium text-primary">
            <ImagePlus className="size-6" />
            Drop images to attach
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        {wantPersistence && !sessionPanelOpen && (
          <Button
            size="sm"
            variant="ghost"
            title="Show sessions"
            onClick={() => setSessionPanelOpen(true)}
          >
            <PanelLeftOpen className="size-4" />
          </Button>
        )}
        <Bot className="size-4 text-muted-foreground" />
        {isStreaming && (
          <span
            className="ml-2 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
            title="The agent is generating a response"
          >
            <Loader2 className="size-3 animate-spin" />
            Streaming
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Select
            value={agentId ?? ""}
            onValueChange={onAgentPick}
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
            variant={showThinking ? "default" : "ghost"}
            title={
              showThinking
                ? "Hide agent thinking blocks (collapsed by default)"
                : "Expand all agent thinking blocks"
            }
            onClick={() => setShowThinking(!showThinking)}
          >
            <Brain className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="What does the agent know about this page?"
            onClick={() => setSkillOpen(true)}
          >
            <Info className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <SkillDialog
        open={skillOpen}
        onOpenChange={setSkillOpen}
        pageContext={
          pageContext.page === "issue-canvas" &&
          pageContext.projectId &&
          pageContext.issueNumber
            ? {
                ...pageContext,
                canvas: {
                  kind: "issue",
                  projectId: pageContext.projectId,
                  issueNumber: pageContext.issueNumber,
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
          />
        ) : (
          <div className="space-y-4">
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                onStreamEnd={handleStreamEnd}
                onOptionSelect={(value) => selectOption(m.id, value)}
                optionsDisabled={
                  sending || isStreaming || answeredOptionMessageIds.has(m.id)
                }
              />
            ))}
          </div>
        )}
      </div>

      {selection && (
        <div className="border-t bg-secondary/40 px-3 py-2">
          <div className="flex items-start gap-2 text-xs">
            <span className="mt-0.5 text-muted-foreground">selection:</span>
            <span className="flex-1 truncate font-mono">{selection}</span>
            {onClearSelection && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onClearSelection}
                className="h-6 px-1"
                title="Clear selection"
              >
                <X className="size-3" />
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="border-t p-3">
        <div className="mb-2 flex items-center gap-2 text-xs">
          <Select
            value={permissionMode}
            onValueChange={(v) => setPermissionMode(v as PermissionMode)}
          >
            <SelectTrigger className="h-7 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              {PERMISSION_MODE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            title="Attach images"
            disabled={!agentId || !effectiveSessionId}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus className="size-4" />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void addImageFiles(e.target.files);
              // Reset so picking the same file twice still fires onChange.
              e.target.value = "";
            }}
          />
          {permissionMode !== "default" && (
            <span className="text-muted-foreground">
              applies to the next turn
            </span>
          )}
        </div>
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((img) => (
              <div
                key={img.id}
                className="group relative size-16 overflow-hidden rounded-md border bg-muted"
              >
                <img
                  src={img.dataUrl}
                  alt={img.name ?? "attachment"}
                  className="size-full object-cover"
                />
                <button
                  type="button"
                  title="Remove image"
                  onClick={() => removeImage(img.id)}
                  className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={
            !effectiveSessionId
              ? "Loading session…"
              : agentId
                ? selection
                  ? "Ask about the selected text… (⌘/Ctrl+Enter)"
                  : "Ask for help with this page… (paste or drop images, ⌘/Ctrl+Enter to send)"
                : "Pick an agent above to start chatting"
          }
          className="min-h-20 resize-none text-sm"
          disabled={!agentId || !effectiveSessionId}
        />
        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>page: {shortPath(pageContext.pathname)}</span>
          {isStreaming ? (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void stop()}
              title="Stop the agent (kills the underlying process)"
            >
              <Square className="size-3.5" />
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={
                !agentId ||
                (!input.trim() && images.length === 0) ||
                sending ||
                !effectiveSessionId
              }
              onClick={() => void send()}
            >
              <Send className="size-3.5" />
              Send
            </Button>
          )}
        </div>
      </div>
      </div>
    </aside>
  );
}

function MessageBubble({
  message,
  onStreamEnd,
  onOptionSelect,
  optionsDisabled,
}: {
  message: Message;
  onStreamEnd?: (id: string, status: string) => void;
  onOptionSelect?: (value: string) => void;
  optionsDisabled?: boolean;
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
        {message.images && message.images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {message.images.map((src, i) => (
              // No anchor wrapper: browsers block top-level navigation to
              // `data:` URLs, so an "open in new tab" link would no-op.
              // The inline thumbnail is the artifact the user wants to see.
              <img
                key={i}
                src={src}
                alt={`attachment ${i + 1}`}
                className="max-h-48 rounded-md border object-contain"
              />
            ))}
          </div>
        )}
        {message.text.trim().length > 0 && (
          <div className="rounded-lg bg-secondary px-3 py-2 text-sm">
            <ChatMarkdown>{message.text}</ChatMarkdown>
          </div>
        )}
      </div>
    );
  }
  return (
    <AssistantBubble
      message={message}
      onStreamEnd={onStreamEnd}
      onOptionSelect={onOptionSelect}
      optionsDisabled={optionsDisabled}
    />
  );
}

function AssistantBubble({
  message,
  onStreamEnd,
  onOptionSelect,
  optionsDisabled,
}: {
  message: Message;
  onStreamEnd?: (id: string, status: string) => void;
  onOptionSelect?: (value: string) => void;
  optionsDisabled?: boolean;
}) {
  const { text } = useStreamedAssistant(message, onStreamEnd);
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const [showThinking] = useShowThinking();

  return (
    <div className="mr-6 space-y-2">
      <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm leading-relaxed">
        {blocks.map((b, i) => {
          if (b.kind === "text") {
            // Empty text blocks during streaming would render an empty
            // <div> with vertical padding from the markdown wrapper —
            // suppress them so the typing dots sit flush.
            if (!b.text) return null;
            return <ChatMarkdown key={i}>{b.text}</ChatMarkdown>;
          }
          if (b.kind === "thinking") {
            return (
              <ThinkingBlock
                key={i}
                content={b.content}
                streaming={b.open}
                forceOpen={showThinking}
              />
            );
          }
          if (b.kind === "tool") {
            return <ToolChip key={i} text={b.text} />;
          }
          if (b.kind === "options") {
            return (
              <OptionsBlock
                key={i}
                block={b}
                disabled={optionsDisabled}
                onSelect={onOptionSelect}
              />
            );
          }
          return <FencedBlock key={i} type={b.type} content={b.content} />;
        })}
        {message.pending && text === "" && (
          <TypingDots />
        )}
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
  "pm",
]);

function useStreamedAssistant(
  message: Message,
  onEnd?: (id: string, status: string, finalText?: string) => void,
): { text: string } {
  const [chunks, setChunks] = useState<string>("");
  const lastRunRef = useRef<string | null>(null);
  // Mirror of the latest `chunks` value, readable inside the SSE `end`
  // handler without a stale closure. Updated in lockstep with setChunks.
  const chunksRef = useRef<string>("");
  const qc = useQueryClient();
  // The latest end-callback the caller passed. Captured in a ref so we
  // don't tear down + recreate the EventSource when the parent re-renders
  // with a new closure (every keystroke in the textarea would otherwise
  // reset the stream).
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => {
    setChunks("");
    chunksRef.current = "";
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
          setChunks((prev) => {
            const next = prev + row.chunk;
            chunksRef.current = next;
            return next;
          });
        }
      } catch {
        // ignore
      }
    });
    es.addEventListener("end", (e: MessageEvent) => {
      es.close();
      let status = "succeeded";
      try {
        const data = JSON.parse(e.data) as { status?: string };
        if (typeof data.status === "string") status = data.status;
      } catch {
        // ignore
      }
      onEndRef.current?.(message.id, status, chunksRef.current);
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
  }, [message.agentRunId, message.id, qc]);

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
interface ThinkingBlockType {
  kind: "thinking";
  /** Raw thought content (may include markdown / code fences inside). */
  content: string;
  /** True while the closing [/think] hasn't arrived yet — drives the
   *  pulsing "thinking…" indicator. */
  open: boolean;
}
interface ToolBlockType {
  kind: "tool";
  /** "[tool] <title> (status)" — the device translator emits one line
   *  per tool start/progress event; we display them as a small chip
   *  group rather than a full collapsed section. */
  text: string;
}
interface OptionsBlockType {
  kind: "options";
  prompt?: string;
  options: ChatOption[];
}
interface ChatOption {
  label: string;
  value: string;
}
type Block =
  | FencedBlockType
  | TextBlockType
  | ThinkingBlockType
  | ToolBlockType
  | OptionsBlockType;

// ─── Block parsing ──────────────────────────────────────────────────
//
// The device's update translator (packages/cli/src/runner/acpRunner.ts)
// fences thought-chunk deltas between `\n[think]\n` / `\n[/think]\n`
// markers and emits `\n[tool] <title> (<status>)\n` lines for tool
// call lifecycle events. Everything else flows through verbatim as
// markdown text — including the agent's own ```code``` fences.
//
// Why two distinct block formats (not "everything is a fence"): a
// model can produce ```backtick fences``` inside its reasoning, which
// would close a single-flavoured ` ```thinking ` fence prematurely.
// `[think]` markers carry zero collision risk in practice — the model
// would have to emit the literal three-character bracket-think-bracket
// sequence at the start of its own line, which doesn't happen in
// natural prose.
//
// Streaming: a half-arrived thinking section (`[think]` present,
// `[/think]` not yet) renders as an open thinking block. Once the
// closing marker arrives the block flips to `open: false`.
const THINK_OPEN_RE = /\n?\[think\]\n/;
const THINK_CLOSE_RE = /\n\[\/think\]\n?/;
const TOOL_LINE_RE = /\n\[tool\] [^\n]*\n/;
const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/;

function parseBlocks(text: string): Block[] {
  const rawOptions = parseOptionsPayload("json", text);
  if (rawOptions) return [rawOptions];

  const out: Block[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const rest = text.slice(cursor);
    // Find the earliest of: [think], [tool], ```fence. Greedy on
    // whichever shows up first; everything before it is plain text.
    const thinkOpen = THINK_OPEN_RE.exec(rest);
    const toolLine = TOOL_LINE_RE.exec(rest);
    const fence = FENCE_RE.exec(rest);
    const candidates: { idx: number; kind: "think" | "tool" | "fence"; match: RegExpExecArray }[] = [];
    if (thinkOpen) candidates.push({ idx: thinkOpen.index, kind: "think", match: thinkOpen });
    if (toolLine) candidates.push({ idx: toolLine.index, kind: "tool", match: toolLine });
    if (fence) candidates.push({ idx: fence.index, kind: "fence", match: fence });
    if (candidates.length === 0) {
      out.push({ kind: "text", text: rest });
      break;
    }
    candidates.sort((a, b) => a.idx - b.idx);
    const first = candidates[0]!;
    if (first.idx > 0) {
      out.push({ kind: "text", text: rest.slice(0, first.idx) });
    }
    if (first.kind === "think") {
      const afterOpen = first.idx + first.match[0].length;
      const tail = rest.slice(afterOpen);
      const close = THINK_CLOSE_RE.exec(tail);
      if (close) {
        out.push({
          kind: "thinking",
          content: tail.slice(0, close.index),
          open: false,
        });
        cursor += afterOpen + close.index + close[0].length;
      } else {
        // Still streaming — show what we have so far as an open block.
        out.push({ kind: "thinking", content: tail, open: true });
        cursor = text.length;
      }
      continue;
    }
    if (first.kind === "tool") {
      out.push({
        kind: "tool",
        text: first.match[0].trim().replace(/^\[tool\]\s*/, ""),
      });
      cursor += first.idx + first.match[0].length;
      continue;
    }
    const fenceType = first.match[1]!.trim() || "text";
    const fenceContent = first.match[2]!;
    const optionsBlock = parseOptionsPayload(fenceType, fenceContent);
    if (optionsBlock) {
      out.push(optionsBlock);
      cursor += first.idx + first.match[0].length;
      continue;
    }

    // Fenced code block.
    out.push({
      kind: "code",
      type: fenceType,
      content: fenceContent,
    });
    cursor += first.idx + first.match[0].length;
  }
  return out;
}

function parseOptionsPayload(
  fenceType: string,
  content: string,
): OptionsBlockType | null {
  const normalizedType = fenceType.trim().toLowerCase();
  if (normalizedType !== "json" && normalizedType !== "options") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const payload = parsed as Record<string, unknown>;
  const responseType = payload.type ?? payload.responseType ?? payload.response_type;
  if (responseType !== "options" && normalizedType !== "options") return null;
  if (!Array.isArray(payload.options)) return null;

  const options = payload.options
    .map((raw) => normalizeChatOption(raw))
    .filter((option): option is ChatOption => option !== null);
  if (options.length === 0) return null;

  const prompt =
    stringValue(payload.text) ??
    stringValue(payload.message) ??
    stringValue(payload.prompt) ??
    undefined;
  return { kind: "options", prompt, options };
}

function normalizeChatOption(raw: unknown): ChatOption | null {
  if (typeof raw === "string") {
    const value = raw.trim();
    return value ? { label: value, value } : null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const option = raw as Record<string, unknown>;
  const label =
    stringValue(option.label) ??
    stringValue(option.title) ??
    stringValue(option.text) ??
    stringValue(option.value);
  const value =
    stringValue(option.value) ??
    stringValue(option.message) ??
    stringValue(option.input) ??
    label;
  if (!label || !value) return null;
  return { label, value };
}

function stringValue(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function ThinkingBlock({
  content,
  streaming,
  forceOpen,
}: {
  content: string;
  streaming: boolean;
  forceOpen: boolean;
}) {
  // `key` on the <details> forces a remount whenever the global toggle
  // changes, which lets the `open` prop reflect the new force value
  // without leaving stale user-driven open/close state lingering. Per-
  // block expand/collapse on the chip itself still works between
  // global toggles.
  return (
    <details
      key={forceOpen ? "open" : "collapsed"}
      open={forceOpen}
      className="my-2 rounded-md border border-dashed border-muted-foreground/30 bg-muted/20"
    >
      <summary
        className={cn(
          "flex cursor-pointer select-none items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground",
          streaming && "animate-pulse",
        )}
      >
        <Brain className="size-3" />
        <span className="font-medium uppercase tracking-wide">
          {streaming ? "Thinking…" : "Thinking"}
        </span>
        <span className="text-[10px] opacity-60">
          {streaming ? "(streaming)" : `(${content.trim().length} chars)`}
        </span>
      </summary>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-dashed border-muted-foreground/20 bg-background/40 p-2 text-xs leading-relaxed">
        {content.trim()}
      </pre>
    </details>
  );
}

function ToolChip({ text }: { text: string }) {
  return (
    <div className="my-1 inline-flex items-center gap-1 rounded-md border bg-background/60 px-2 py-0.5 text-[11px] text-muted-foreground">
      <Wrench className="size-3" />
      <span className="font-mono">{text}</span>
    </div>
  );
}

function OptionsBlock({
  block,
  disabled,
  onSelect,
}: {
  block: OptionsBlockType;
  disabled?: boolean;
  onSelect?: (value: string) => void;
}) {
  return (
    <div className="my-2 space-y-2">
      {block.prompt && (
        <p className="whitespace-pre-wrap break-words">{block.prompt}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {block.options.map((option, i) => (
          <Button
            key={`${option.value}-${i}`}
            type="button"
            size="sm"
            variant="outline"
            className="h-auto min-h-8 whitespace-normal text-left"
            disabled={disabled || !onSelect}
            onClick={() => onSelect?.(option.value)}
            title={option.value !== option.label ? option.value : undefined}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function TypingDots() {
  // Three staggered dots — same idiom as iMessage / Slack so it reads
  // as "the agent is generating" without needing a label.
  return (
    <span
      className="inline-flex items-center gap-0.5 text-muted-foreground"
      aria-label="agent is typing"
    >
      <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-current" />
    </span>
  );
}

/**
 * Collapsible session sidebar (issue #143) — replaces the old History
 * dialog. Lists every chat session for the current scope, split into a
 * "Running" group (sessions with an in-flight agent run, marked with a
 * pulsing dot) and a "History" group (everything else, most-recent
 * first); archived sessions trail behind for restore. The "+" button
 * starts a fresh session without interrupting any running one. Rename /
 * archive / restore live on each row as hover actions.
 */
function SessionPanel({
  sessions,
  activeSessionId,
  loading,
  onCollapse,
  onNewChat,
  onPick,
  onRename,
  onDelete,
  onRestore,
  onHardDelete,
}: {
  sessions: ChatSession[];
  activeSessionId: string | null;
  loading: boolean;
  onCollapse: () => void;
  onNewChat: () => Promise<void> | void;
  onPick: (s: ChatSession) => void;
  onRename: (id: string, title: string | null) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onHardDelete: (id: string) => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  // Pressing Enter on the rename input fires commitRename, and the
  // synchronous unmount that follows ALSO fires onBlur — which would
  // call commitRename again and fire a duplicate PATCH. Track the last
  // committed id so the second call short-circuits. Reset on new rename.
  const committedIdRef = useRef<string | null>(null);
  const commitRenameOnce = (s: ChatSession) => {
    if (committedIdRef.current === s.id) return;
    committedIdRef.current = s.id;
    onRename(s.id, draftTitle.trim() || null);
    setRenamingId(null);
  };
  const startRenameAndReset = (s: ChatSession) => {
    committedIdRef.current = null;
    setRenamingId(s.id);
    setDraftTitle(s.title ?? "");
  };
  const cancelRenameAndReset = () => {
    committedIdRef.current = null;
    setRenamingId(null);
  };

  const { running, history, archived } = partitionSessions(sessions);
  const rowProps = {
    activeSessionId,
    renamingId,
    draftTitle,
    setDraftTitle,
    startRename: startRenameAndReset,
    commitRename: commitRenameOnce,
    cancelRename: cancelRenameAndReset,
    onPick,
    onDelete,
    onRestore,
    onHardDelete,
  };

  return (
    <div className="flex h-full w-56 shrink-0 flex-col border-r bg-muted/20">
      <div className="flex items-center gap-1 border-b px-3 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Sessions
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="size-7 p-0"
            title="New session"
            onClick={() => void onNewChat()}
          >
            <Plus className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="size-7 p-0"
            title="Collapse session panel"
            onClick={onCollapse}
          >
            <PanelLeftClose className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-1">
        {loading && sessions.length === 0 && (
          <p className="px-1 py-2 text-xs text-muted-foreground">Loading…</p>
        )}
        {!loading && sessions.length === 0 && (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            No conversations yet. Press + to start one.
          </p>
        )}
        {running.length > 0 && (
          <SessionGroup label="Running">
            {running.map((s) => (
              <SessionRow key={s.id} session={s} {...rowProps} />
            ))}
          </SessionGroup>
        )}
        {history.length > 0 && (
          <SessionGroup label="History">
            {history.map((s) => (
              <SessionRow key={s.id} session={s} {...rowProps} />
            ))}
          </SessionGroup>
        )}
        {archived.length > 0 && (
          <SessionGroup label="Archived">
            {archived.map((s) => (
              <SessionRow key={s.id} session={s} {...rowProps} />
            ))}
          </SessionGroup>
        )}
      </div>
    </div>
  );
}

/**
 * Split a scope's sessions into the three sidebar groups:
 *   - running:  active (non-archived) sessions with an in-flight agent run
 *   - history:  the remaining active (non-archived) sessions
 *   - archived: soft-deleted sessions (kept for restore)
 * Input order is preserved — the list endpoint returns rows most-recent
 * first, so each group stays sorted by recency without re-sorting here.
 *
 * Exported for unit tests.
 */
export function partitionSessions(sessions: ChatSession[]): {
  running: ChatSession[];
  history: ChatSession[];
  archived: ChatSession[];
} {
  const running: ChatSession[] = [];
  const history: ChatSession[] = [];
  const archived: ChatSession[] = [];
  for (const s of sessions) {
    // Archived wins over running: a soft-deleted thread stays under
    // "Archived" (for restore) even if a run is somehow still in flight,
    // rather than resurfacing in the Running group.
    if (s.archivedAt) archived.push(s);
    else if (s.running) running.push(s);
    else history.push(s);
  }
  return { running, history, archived };
}

function SessionGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-2 first:mt-1">
      <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}

function SessionRow({
  session: s,
  activeSessionId,
  renamingId,
  draftTitle,
  setDraftTitle,
  startRename,
  commitRename,
  cancelRename,
  onPick,
  onDelete,
  onRestore,
  onHardDelete,
}: {
  session: ChatSession;
  activeSessionId: string | null;
  renamingId: string | null;
  draftTitle: string;
  setDraftTitle: (v: string) => void;
  startRename: (s: ChatSession) => void;
  commitRename: (s: ChatSession) => void;
  cancelRename: () => void;
  onPick: (s: ChatSession) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onHardDelete: (id: string) => void;
}) {
  const isActive = s.id === activeSessionId;
  const isRenaming = s.id === renamingId;
  return (
    <li
      className={cn(
        "group flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs",
        isActive
          ? "border-primary/60 bg-primary/5"
          : "border-transparent hover:bg-muted/50",
      )}
    >
      {s.running && !s.archivedAt && (
        <span
          className="relative flex size-2 shrink-0"
          title="Agent is running"
          aria-label="running"
        >
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/70" />
          <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
        </span>
      )}
      {isRenaming ? (
        <input
          autoFocus
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename(s);
            if (e.key === "Escape") cancelRename();
          }}
          onBlur={() => commitRename(s)}
          className="min-w-0 flex-1 rounded border bg-background px-1 text-xs"
        />
      ) : (
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left"
          onClick={() => onPick(s)}
          title="Switch to this conversation"
        >
          <span className="font-medium">{s.title || "(untitled)"}</span>
        </button>
      )}
      {!isRenaming && (
        <>
          {/* Timestamp normally; swaps to the action cluster on hover so
              the narrow row isn't cluttered with both at once. In Tailwind
              v4 the group-hover selector uses :where() which can match the
              specificity of the static hidden/visible classes — use the !
              suffix to guarantee the hover state always wins the cascade. */}
          <span className="shrink-0 text-[10px] text-muted-foreground group-hover:hidden!">
            {formatRelative(s.updatedAt)}
          </span>
          <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex!">
            <Button
              size="sm"
              variant="ghost"
              className="size-6 p-0"
              title="Rename"
              onClick={() => startRename(s)}
            >
              <Pencil className="size-3" />
            </Button>
            {s.archivedAt ? (
              <Button
                size="sm"
                variant="ghost"
                className="size-6 p-0"
                title="Restore (un-archive)"
                onClick={() => onRestore(s.id)}
              >
                <ArchiveRestore className="size-3" />
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="size-6 p-0"
                title="Archive"
                onClick={() => onDelete(s.id)}
              >
                <Archive className="size-3" />
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="size-6 p-0 text-destructive hover:text-destructive"
              title="Delete permanently"
              onClick={() => {
                // Irreversible: confirm before dropping the session and
                // its chat history for good (acceptance criteria #2/#5).
                if (
                  window.confirm(
                    `Permanently delete "${s.title || "(untitled)"}"? ` +
                      `This removes the conversation and its chat history ` +
                      `and cannot be undone.`,
                  )
                ) {
                  onHardDelete(s.id);
                }
              }}
            >
              <Trash2 className="size-3" />
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

// Rough relative-time formatter — enough for the History list. Not a
// general utility; we don't need full intl precision for "x minutes
// ago" timestamps in a sidebar.
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.max(0, (Date.now() - then) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function FencedBlock({ type, content }: { type: string; content: string }) {
  const { resolve, version } = useChatActions();
  // version dependency forces a re-render when actions register/unregister.
  void version;
  const handler = resolve(type);
  const highlighted = useMemo(
    () => highlightCode(type, content),
    [type, content],
  );
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
        {highlighted ? (
          <code
            className={`hljs language-${type}`}
            // highlight.js returns escaped HTML — innerHTML is safe here.
            // The agent-supplied source text is *not* injected as HTML;
            // only hljs's own classname spans (<span class="hljs-…">) are.
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          content
        )}
      </pre>
    </div>
  );
}

/**
 * Run highlight.js over a fenced block's content, returning escaped HTML
 * with hljs token spans, or null when the language tag isn't one hljs
 * knows about (in which case the caller falls back to plain text — safer
 * than letting hljs guess, which routinely mis-colours JSON as Lua etc).
 */
function highlightCode(type: string, content: string): string | null {
  const language = type.trim().toLowerCase();
  if (!language || language === "text" || language === "plain") return null;
  if (!hljs.getLanguage(language)) return null;
  try {
    return hljs.highlight(content, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
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
        Chat with one of your agents. Select text on any page and click
        &ldquo;Chat about this&rdquo; to include it as context.
      </p>
      <p className="text-xs">
        Page: <span className="font-mono">{shortPath(pageContext.pathname)}</span>
        {agents.length === 0 && " — define an agent first under /agents."}
      </p>
    </div>
  );
}

/**
 * Strip `[think]…[/think]` blocks and `[tool]` lines from assistant
 * text before sending it as conversation history. History is a fallback
 * for when session resume isn't available — the model only needs the
 * visible reply content, not internal reasoning or tool invocations
 * that were already handled by the prior turn.
 */
function stripInternalMarkers(text: string): string {
  return text
    .replace(/\n?\[think\]\n[\s\S]*?\n\[\/think\]\n?/g, "")
    .replace(/(?:^|\n)\[tool\] [^\n]*(?:\n|$)/g, "")
    .trim();
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
            <div className="prose prose-sm max-h-[60vh] w-full min-w-0 max-w-none overflow-y-auto break-words rounded-md border bg-background p-3 dark:prose-invert [&_code]:break-all [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words">
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
