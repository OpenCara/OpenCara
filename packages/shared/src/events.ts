import { z } from "zod";

export const PlatformSchema = z.enum(["github"]);
export type Platform = z.infer<typeof PlatformSchema>;

export const PlatformEventSchema = z.object({
  id: z.string(),
  platform: PlatformSchema,
  type: z.string(),
  receivedAt: z.string().datetime(),
  payload: z.unknown(),
});
export type PlatformEvent = z.infer<typeof PlatformEventSchema>;
