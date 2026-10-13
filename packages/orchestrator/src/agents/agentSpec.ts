// Builds the AgentSpec for an agent turn: the device runs it in-process as a
// pi-durable conversation (see `TurnSpecSchema` in @opencara/shared). One
// builder for every dispatch path — chat, the agent test endpoint and flow
// agent nodes.

import {
  isThinkingLevel,
  type AgentSpec,
  type HistoryTurn,
  type ImageInput,
  type TurnSpec,
} from "@opencara/shared";

export interface BuildAgentSpecOpts {
  agent: {
    name: string;
    /** `<provider>/<modelId>` (the `model` column). */
    model: string;
    cwd: string | null;
    /** The `capture_thinking` column. Undefined = capture. */
    captureThinking?: boolean;
    /** The `thought_level` column. Null/undefined/empty = the device's pi default. */
    thoughtLevel?: string | null;
  };
  env: Record<string, string>;
  systemPromptMd: string;
  userPromptMd: string;
  history?: HistoryTurn[];
  pageContext?: Record<string, unknown>;
  /** Resume this durable conversation; the caller pins the job to the
   *  device that holds it. */
  priorConversationId?: string;
  /** Repo-relative project instructions file, already validated via
   *  `validateInstructionsFileSetting`; the device reads it from the job cwd. */
  instructionsFile?: string;
  images?: ImageInput[];
}

export function buildAgentSpec(opts: BuildAgentSpecOpts): AgentSpec {
  const thoughtLevel = opts.agent.thoughtLevel?.trim();
  const turn: TurnSpec = {
    model: opts.agent.model,
    systemPromptMd: opts.systemPromptMd,
    userPromptMd: opts.userPromptMd,
    history: opts.history ?? [],
    images: opts.images ?? [],
    ...(opts.pageContext && Object.keys(opts.pageContext).length > 0
      ? { pageContextJson: JSON.stringify(opts.pageContext) }
      : {}),
    ...(opts.priorConversationId ? { priorConversationId: opts.priorConversationId } : {}),
    ...(opts.instructionsFile ? { instructionsFile: opts.instructionsFile } : {}),
    // Only sent when OFF: absent means capture, so the default stays off the wire.
    ...(opts.agent.captureThinking === false ? { captureThinking: false } : {}),
    ...(thoughtLevel && isThinkingLevel(thoughtLevel) ? { thoughtLevel } : {}),
  };
  return {
    kind: opts.agent.name,
    args: [],
    env: opts.env,
    cwd: opts.agent.cwd ?? undefined,
    turn,
  };
}

