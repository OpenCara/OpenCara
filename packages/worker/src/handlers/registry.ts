import { DEFAULT_REGISTRY } from '@opencrust/shared';

export function handleGetRegistry(): Response {
  return Response.json(DEFAULT_REGISTRY);
}
