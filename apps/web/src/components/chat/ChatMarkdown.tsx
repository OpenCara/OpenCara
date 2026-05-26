import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

interface Props {
  children: string;
  /** Extra classes applied to the root wrapper. */
  className?: string;
}

// Tailwind-arbitrary descendant selectors used to style markdown output
// without pulling in @tailwindcss/typography. Headings stay modest in
// scale since they appear inside chat bubbles, not full-page documents.
const ROOT_CLASSES = [
  "break-words text-sm leading-relaxed",
  // Paragraphs
  "[&>p]:my-2 first:[&>p]:mt-0 last:[&>p]:mb-0",
  // Headings
  "[&>h1]:mt-3 [&>h1]:mb-2 [&>h1]:text-base [&>h1]:font-semibold",
  "[&>h2]:mt-3 [&>h2]:mb-2 [&>h2]:text-base [&>h2]:font-semibold",
  "[&>h3]:mt-2 [&>h3]:mb-1 [&>h3]:text-sm [&>h3]:font-semibold",
  "[&>h4]:mt-2 [&>h4]:mb-1 [&>h4]:text-sm [&>h4]:font-semibold",
  "[&>h5]:mt-2 [&>h5]:mb-1 [&>h5]:text-xs [&>h5]:font-semibold [&>h5]:uppercase [&>h5]:tracking-wide",
  "[&>h6]:mt-2 [&>h6]:mb-1 [&>h6]:text-xs [&>h6]:font-semibold [&>h6]:uppercase [&>h6]:tracking-wide",
  // Lists
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
  "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-0.5 [&_li>p]:my-0",
  // Inline code
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
  // Code blocks (when ReactMarkdown encounters them — usually FencedBlock
  // handles these, but keep a sane default for inline `<pre>` content).
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-background [&_pre]:p-2 [&_pre]:text-xs",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[0.95em]",
  // Blockquote
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-muted-foreground/40 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  // Tables (remark-gfm)
  "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs",
  "[&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold",
  "[&_td]:border [&_td]:px-2 [&_td]:py-1",
  // Horizontal rule
  "[&_hr]:my-3 [&_hr]:border-border",
].join(" ");

const components: Components = {
  // Force-open external links in a new tab and harden the rel attr so
  // user-supplied markdown can't repaint our window via window.opener.
  a({ href, children, ...rest }) {
    const external = !!href && /^https?:\/\//.test(href);
    return (
      <a
        {...rest}
        href={href}
        className="text-primary underline underline-offset-2 hover:text-primary/80"
        {...(external
          ? { target: "_blank", rel: "noopener noreferrer" }
          : {})}
      >
        {children as ReactNode}
      </a>
    );
  },
};

/**
 * Markdown renderer for chat message content.
 *
 * Uses react-markdown's default HTML sanitization (no rehype-raw) so any
 * raw `<script>` / `<img onerror=...>` in agent output renders as plain
 * text rather than live HTML — the XSS guarantee called out in #121.
 *
 * Fenced code blocks are NOT highlighted here. Both AssistantBubble's
 * parseBlocks and FencedBlock strip ``` fences out of the markdown
 * stream and render them through a dedicated component, so the only
 * code this renderer needs to handle is inline `code` spans (styled
 * via the descendant selectors on the root wrapper).
 */
export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  className,
}: Props) {
  return (
    <div className={cn(ROOT_CLASSES, className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
