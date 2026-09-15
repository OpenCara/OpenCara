import { useMemo } from "react";
import hljs from "highlight.js/lib/common";
import { Brain, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useChatActions } from "@/lib/chatActions";
import { ChatMarkdown } from "./ChatMarkdown";
import { useShowThinking } from "./preferences";

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

export { TypingDots };

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

/**
 * The chat-style agent-output renderer, usable anywhere a raw agent stdout
 * stream is shown: markdown text, collapsible [think] blocks, [tool] chips,
 * fenced code (with syntax highlighting + page-registered "Apply" actions),
 * and options blocks (rendered disabled when no onOptionSelect is given).
 */
export function AgentOutputBlocks({
  text,
  optionsDisabled,
  onOptionSelect,
}: {
  text: string;
  optionsDisabled?: boolean;
  onOptionSelect?: (value: string) => void;
}) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const [showThinking] = useShowThinking();
  return (
    <>
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
    </>
  );
}

/** Minimal shape of one persisted/streamed agent log line. */
export interface AgentLogLine {
  seq: number;
  stream: "stdout" | "stderr";
  chunk: string;
}

/**
 * Agent run log viewer with the chat output format as default: the stdout
 * stream is rendered through AgentOutputBlocks (markdown + thinking fences
 * + tool chips), and stderr — adapter diagnostics the block parser can't
 * model ([acp] unmodeled update, "v2 turn failed", …) — is kept verbatim in
 * a labelled red block underneath rather than corrupting the marker stream.
 */
export function AgentLogStream({
  events,
  empty = "(no output)",
}: {
  events: AgentLogLine[];
  empty?: string;
}) {
  const stdout = useMemo(
    () =>
      events
        .filter((e) => e.stream === "stdout")
        .map((e) => e.chunk)
        .join(""),
    [events],
  );
  const stderr = useMemo(
    () =>
      events
        .filter((e) => e.stream === "stderr")
        .map((e) => e.chunk)
        .join(""),
    [events],
  );
  if (events.length === 0) {
    return <p className="text-xs text-muted-foreground">{empty}</p>;
  }
  return (
    <div>
      {stdout.length > 0 ? (
        <AgentOutputBlocks text={stdout} />
      ) : (
        <p className="text-xs text-muted-foreground">(no stdout output)</p>
      )}
      {stderr.length > 0 && (
        <details className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 text-xs">
          <summary className="cursor-pointer select-none px-2 py-1 font-medium uppercase tracking-wide text-destructive/80">
            stderr
          </summary>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words border-t border-destructive/20 p-2 font-mono text-[11px] leading-snug text-destructive">
            {stderr}
          </pre>
        </details>
      )}
    </div>
  );
}
