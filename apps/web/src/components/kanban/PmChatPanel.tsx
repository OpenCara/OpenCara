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

  return (
    <ChatPanel
      open={open}
      onClose={onClose}
      variant="floating"
      forcePageId="project-pm"
      sessionIdOverride={session?.threadKey}
      initialAgentId={session?.agentId ?? null}
      onAgentChange={(agentId) => updateAgent.mutate({ agentId })}
    />
  );
}
