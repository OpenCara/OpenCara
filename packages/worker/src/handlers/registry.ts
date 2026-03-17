import type { RegistryResponse } from '@opencrust/shared';

const REGISTRY: RegistryResponse = {
  tools: [
    {
      name: 'claude-code',
      displayName: 'Claude Code',
      binary: 'claude',
      commandTemplate: 'claude -p --output-format text',
      tokenParser: 'claude',
    },
    {
      name: 'codex',
      displayName: 'Codex',
      binary: 'codex',
      commandTemplate: 'codex exec',
      tokenParser: 'codex',
    },
    {
      name: 'gemini',
      displayName: 'Gemini',
      binary: 'gemini',
      commandTemplate: 'gemini -p',
      tokenParser: 'gemini',
    },
    {
      name: 'qwen',
      displayName: 'Qwen',
      binary: 'qwen',
      commandTemplate: 'qwen -y -m ${MODEL}',
      tokenParser: 'qwen',
    },
  ],
  models: [
    { name: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', tools: ['claude-code'] },
    { name: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', tools: ['claude-code'] },
    { name: 'gpt-5-codex', displayName: 'GPT-5 Codex', tools: ['codex'] },
    { name: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', tools: ['gemini'] },
    { name: 'qwen3.5-plus', displayName: 'Qwen 3.5 Plus', tools: ['qwen'] },
    { name: 'glm-5', displayName: 'GLM-5', tools: ['qwen'] },
    { name: 'kimi-k2.5', displayName: 'Kimi K2.5', tools: ['qwen'] },
    { name: 'minimax-m2.5', displayName: 'Minimax M2.5', tools: ['qwen'] },
  ],
};

export function handleGetRegistry(): Response {
  return Response.json(REGISTRY);
}
