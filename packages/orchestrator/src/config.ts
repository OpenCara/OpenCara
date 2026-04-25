import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().or(z.string().startsWith("postgres://")),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AppConfig {
  return ConfigSchema.parse({
    PORT: process.env["PORT"],
    DATABASE_URL: process.env["DATABASE_URL"] ?? "postgres://openkira:openkira@localhost:5432/openkira",
    GITHUB_WEBHOOK_SECRET: process.env["GITHUB_WEBHOOK_SECRET"] ?? "changeme",
  });
}
