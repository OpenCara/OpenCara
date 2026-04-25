import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string()
    .refine((s) => s.startsWith("postgres://") || s.startsWith("postgresql://"), {
      message: "DATABASE_URL must start with postgres:// or postgresql://",
    }),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AppConfig {
  return ConfigSchema.parse({
    PORT: process.env["PORT"],
    DATABASE_URL: process.env["DATABASE_URL"] ?? "postgres://openkira:openkira@localhost:5433/openkira",
    GITHUB_WEBHOOK_SECRET: process.env["GITHUB_WEBHOOK_SECRET"] ?? "changeme",
  });
}
