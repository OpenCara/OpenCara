import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface IssueBodyEditorProps {
  bodyMd: string;
  onChange: (next: string) => void;
  onSelectionChange: (selection: string | null) => void;
}

// Renders the issue body as markdown by default; toggling to Edit swaps in a
// plain textarea so the user can do small freeform edits without bothering an
// agent. Selection-driven rewrites only fire from the rendered view — text
// selection inside the textarea is the OS's built-in edit buffer and isn't
// what we want to send to an agent anyway.
export function IssueBodyEditor({
  bodyMd,
  onChange,
  onSelectionChange,
}: IssueBodyEditorProps) {
  const [mode, setMode] = useState<"render" | "edit">("render");
  const renderRef = useRef<HTMLDivElement | null>(null);

  // Capture the selection within the rendered body. We snapshot the text on
  // mouseup/keyup; the parent decides what to do with it (typically: feed to
  // ChatPanel as canvas selection context). Clicking outside the body clears.
  useEffect(() => {
    if (mode !== "render") return;
    const onSelectionEvent = () => {
      const sel = window.getSelection();
      const text = sel?.toString() ?? "";
      if (!text.trim() || !renderRef.current) {
        onSelectionChange(null);
        return;
      }
      // Make sure the selection is inside our render container — selecting
      // chat text or header text shouldn't count.
      const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
      if (!range) {
        onSelectionChange(null);
        return;
      }
      const ancestor = range.commonAncestorContainer;
      const inside =
        renderRef.current === ancestor ||
        renderRef.current.contains(
          ancestor.nodeType === 1 ? (ancestor as Element) : ancestor.parentElement,
        );
      onSelectionChange(inside ? text : null);
    };
    document.addEventListener("selectionchange", onSelectionEvent);
    return () => document.removeEventListener("selectionchange", onSelectionEvent);
  }, [mode, onSelectionChange]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-2">
        <Button
          variant={mode === "render" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setMode("render")}
        >
          Preview
        </Button>
        <Button
          variant={mode === "edit" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setMode("edit")}
        >
          Edit
        </Button>
      </div>
      {mode === "render" ? (
        <div
          ref={renderRef}
          className={cn(
            "rounded-md border border-border/60 p-4 text-sm leading-relaxed",
            "[&_h1]:mb-3 [&_h1]:mt-4 [&_h1]:text-xl [&_h1]:font-semibold",
            "[&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold",
            "[&_h3]:mb-2 [&_h3]:mt-3 [&_h3]:text-base [&_h3]:font-semibold",
            "[&_p]:mb-3",
            "[&_ul]:mb-3 [&_ul]:ml-5 [&_ul]:list-disc",
            "[&_ol]:mb-3 [&_ol]:ml-5 [&_ol]:list-decimal",
            "[&_li]:mb-1",
            "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
            "[&_pre]:mb-3 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-xs",
            "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
            "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-muted-foreground",
            "[&_a]:text-primary [&_a]:underline-offset-2 hover:[&_a]:underline",
            "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse",
            "[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold",
            "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1",
            "[&_hr]:my-4 [&_hr]:border-border",
          )}
        >
          {bodyMd ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{bodyMd}</ReactMarkdown>
          ) : (
            <p className="italic text-muted-foreground">No description.</p>
          )}
        </div>
      ) : (
        <Textarea
          value={bodyMd}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-[480px] font-mono text-xs"
          placeholder="Issue body (markdown)"
        />
      )}
    </div>
  );
}
