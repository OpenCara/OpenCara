import { DEFAULT_REGISTRY } from '@opencara/shared';

export function handleGetRegistry(): Response {
  return Response.json(DEFAULT_REGISTRY);
}
