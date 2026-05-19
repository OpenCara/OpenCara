import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  /** Container element — selections outside this element are ignored. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Called when the user clicks "Chat about this" with the selected text. */
  onChatWithSelection: (text: string) => void;
}

/**
 * Floating toolbar that appears near the user's text selection inside a
 * given container. Works on desktop (mouse selection) and mobile (long-
 * press selection). Clicking "Chat about this" invokes the callback with
 * the selected text; the toolbar then hides.
 */
export function SelectionToolbar({ containerRef, onChatWithSelection }: Props) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const textRef = useRef("");

  const evaluate = useCallback(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!text || !sel?.rangeCount) {
      setVisible(false);
      return;
    }
    const container = containerRef.current;
    if (!container) {
      setVisible(false);
      return;
    }
    const range = sel.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const el =
      ancestor.nodeType === 1
        ? (ancestor as Element)
        : ancestor.parentElement;
    if (!el || !container.contains(el)) {
      setVisible(false);
      return;
    }
    textRef.current = text;
    const rect = range.getBoundingClientRect();
    const gap = 8;
    const toolbarH = 36;
    const top =
      rect.top - toolbarH - gap < 0
        ? rect.bottom + gap
        : rect.top - toolbarH - gap;
    const left = Math.max(
      70,
      Math.min(rect.left + rect.width / 2, window.innerWidth - 70),
    );
    setPos({ top, left });
    setVisible(true);
  }, [containerRef]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    // Desktop: evaluate after mouse release (selection finalized).
    const onMouseUp = () => {
      clearTimeout(timer);
      timer = setTimeout(evaluate, 10);
    };

    // Keyboard & mobile: debounced selectionchange.
    const onSelectionChange = () => {
      clearTimeout(timer);
      timer = setTimeout(evaluate, 200);
    };

    // Stale position after scroll / resize — hide until re-evaluated.
    const hide = () => setVisible(false);

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("resize", hide, { passive: true });
    containerRef.current?.addEventListener("scroll", hide, { passive: true });

    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("resize", hide);
      containerRef.current?.removeEventListener("scroll", hide);
      clearTimeout(timer);
    };
  }, [evaluate, containerRef]);

  if (!visible) return null;

  return (
    <div
      className="fixed z-50 -translate-x-1/2 rounded-lg border bg-card px-1 py-1 shadow-lg"
      style={{ top: pos.top, left: pos.left }}
      // Prevent the click from clearing the browser's text selection.
      onMouseDown={(e) => e.preventDefault()}
    >
      <Button
        size="sm"
        variant="ghost"
        className="h-8 gap-1.5 text-xs font-medium"
        onClick={() => {
          onChatWithSelection(textRef.current);
          setVisible(false);
        }}
      >
        <MessageCircle className="size-3.5" />
        Chat about this
      </Button>
    </div>
  );
}
