-- Command Code (`cmd`) speaks ACP through the `cmd-acp` stdio bridge.
ALTER TYPE "agent_kind" ADD VALUE IF NOT EXISTS 'commandcode';
