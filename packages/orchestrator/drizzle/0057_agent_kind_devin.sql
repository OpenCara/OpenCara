-- Devin CLI speaks ACP natively through `devin acp`.
ALTER TYPE "agent_kind" ADD VALUE IF NOT EXISTS 'devin';
