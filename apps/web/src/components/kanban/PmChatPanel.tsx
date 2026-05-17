import { useQuery } from "@tanstack/react-query";
import { ChatPanel } from "@/components/chat/ChatPanel";
import {
  pmSessionQuery,
  usePmSessionAgentMutation,
} from "@/lib/queries";

interface PmChatPanelProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
}

/**
 * Thin wrapper around ChatPanel that injects PM-specific props:
 *   - forcePageId="project-pm"    → always use the PM skill regardless of URL
 *   - sessionIdOverride           → persistent thread from pm_sessions.threadKey
 *   - initialAgentId / onAgentChange → persist agent selection back to pm_sessions
 */
export function PmChatPanel({ open, onClose, projectId }: PmChatPanelProps) {
  const sessionQ = useQuery({
    ...pmSessionQuery(projectId),
    // Enabled always so the thread key is ready when the panel opens.
    enabled: true,
  });
  const updateAgent = usePmSessionAgentMutation(projectId);

  const session = sessionQ.data?.session;

  // Until the session loads, render a closed shell so ChatPanel's useState
  // never runs with initialAgentId=null.  Once session is available we mount
  // the real instance with the correct initialAgentId — useState captures the
  // right value on the very first render and the auto-pick effect can't race
  // ahead of it.
  if (!session) {
    return <ChatPanel open={false} onClose={onClose} variant="floating" />;
  }

  // key={session.threadKey} ensures React unmounts the loading shell and
  // mounts a fresh ChatPanel instance once the real threadKey is known.
  // Without it, React reuses the same component instance (same tree position,
  // same type) and useState(initialAgentId) keeps the null it captured on
  // the shell's first render — the persisted agent is silently ignored.
  return (
    <ChatPanel
      key={session.threadKey}
      open={open}
      onClose={onClose}
      variant="floating"
      forcePageId="project-pm"
      sessionIdOverride={session.threadKey}
      initialAgentId={session.agentId ?? null}
      onAgentChange={(agentId) => updateAgent.mutate({ agentId })}
    />
  );
}
