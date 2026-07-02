import { z } from "zod";
import { readFileSync } from "node:fs";

const BaseSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3030),
  DATABASE_URL: z
    .string()
    .refine((s) => s.startsWith("postgres://") || s.startsWith("postgresql://"), {
      message: "DATABASE_URL must start with postgres:// or postgresql://",
    }),
  GITHUB_WEBHOOK_SECRET: z
    .string()
    .min(1)
    .refine((s) => s !== "changeme", {
      message:
        "GITHUB_WEBHOOK_SECRET is the placeholder 'changeme' — anyone could forge signed webhooks and drive agent runs. Generate a real secret (`openssl rand -hex 32`) and configure it on the GitHub App.",
    }),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3030"),
  /**
   * Wall-clock ceiling for a dispatched agent job, in ms. A wedged agent on
   * a healthy socket otherwise pins its flow run as "running" forever — the
   * only recovery being an orchestrator restart. 0 disables (not advised).
   */
  JOB_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(60 * 60 * 1000),
  SESSION_COOKIE_NAME: z.string().min(1).default("ocara_sid"),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(14),
  SESSION_ENCRYPTION_KEY: z
    .string()
    .optional()
    .refine((s) => !s || /^[0-9a-fA-F]{64}$/.test(s), {
      message: "SESSION_ENCRYPTION_KEY must be 32 bytes (64 hex chars) — use `openssl rand -hex 32`",
    }),
});

const AppGithubSchema = z
  .object({
    GITHUB_APP_ID: z.coerce.number().int().positive(),
    GITHUB_APP_CLIENT_ID: z.string().min(1),
    GITHUB_APP_CLIENT_SECRET: z.string().min(1),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY_PATH: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.GITHUB_APP_PRIVATE_KEY && !v.GITHUB_APP_PRIVATE_KEY_PATH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Set GITHUB_APP_PRIVATE_KEY (PEM string) or GITHUB_APP_PRIVATE_KEY_PATH (file path)",
      });
    }
  });

export interface AppConfig {
  PORT: number;
  DATABASE_URL: string;
  GITHUB_WEBHOOK_SECRET: string;
  PUBLIC_BASE_URL: string;
  JOB_TIMEOUT_MS: number;
  SESSION_COOKIE_NAME: string;
  SESSION_TTL_DAYS: number;
  SESSION_ENCRYPTION_KEY?: string | undefined;
  github:
    | {
        appId: number;
        clientId: string;
        clientSecret: string;
        privateKeyPem: string;
      }
    | null;
}

export function loadConfig(): AppConfig {
  // No fallbacks for DATABASE_URL / GITHUB_WEBHOOK_SECRET: a prod boot that
  // forgot its env used to silently run with dev DB creds and a publicly
  // known webhook secret. Fail closed instead — dev already loads a .env
  // via --env-file (see package.json scripts + README).
  const base = BaseSchema.parse({
    PORT: process.env["PORT"],
    DATABASE_URL: process.env["DATABASE_URL"],
    GITHUB_WEBHOOK_SECRET: process.env["GITHUB_WEBHOOK_SECRET"],
    PUBLIC_BASE_URL: process.env["PUBLIC_BASE_URL"],
    JOB_TIMEOUT_MS: process.env["JOB_TIMEOUT_MS"],
    SESSION_COOKIE_NAME: process.env["SESSION_COOKIE_NAME"],
    SESSION_TTL_DAYS: process.env["SESSION_TTL_DAYS"],
    SESSION_ENCRYPTION_KEY: process.env["SESSION_ENCRYPTION_KEY"],
  });

  const hasAnyApp =
    !!process.env["GITHUB_APP_ID"] ||
    !!process.env["GITHUB_APP_CLIENT_ID"] ||
    !!process.env["GITHUB_APP_CLIENT_SECRET"] ||
    !!process.env["GITHUB_APP_PRIVATE_KEY"] ||
    !!process.env["GITHUB_APP_PRIVATE_KEY_PATH"];

  let github: AppConfig["github"] = null;
  if (hasAnyApp) {
    const appCfg = AppGithubSchema.parse({
      GITHUB_APP_ID: process.env["GITHUB_APP_ID"],
      GITHUB_APP_CLIENT_ID: process.env["GITHUB_APP_CLIENT_ID"],
      GITHUB_APP_CLIENT_SECRET: process.env["GITHUB_APP_CLIENT_SECRET"],
      GITHUB_APP_PRIVATE_KEY: process.env["GITHUB_APP_PRIVATE_KEY"],
      GITHUB_APP_PRIVATE_KEY_PATH: process.env["GITHUB_APP_PRIVATE_KEY_PATH"],
    });
    const privateKeyPem = appCfg.GITHUB_APP_PRIVATE_KEY
      ? appCfg.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n")
      : readFileSync(appCfg.GITHUB_APP_PRIVATE_KEY_PATH!, "utf8");
    github = {
      appId: appCfg.GITHUB_APP_ID,
      clientId: appCfg.GITHUB_APP_CLIENT_ID,
      clientSecret: appCfg.GITHUB_APP_CLIENT_SECRET,
      privateKeyPem,
    };
  }

  return { ...base, github };
}
