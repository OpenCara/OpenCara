#!/usr/bin/env node
import { run } from "./commands/run.js";
import { status } from "./commands/status.js";
import { logout } from "./commands/logout.js";

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case undefined:
    case "run":
    case "register":
      // `run` and bare `opencara` and the legacy `register` all share one
      // path: pair if there's no config (or --force), then start the
      // job-accepting loop.
      await run({
        force: rest.includes("--force"),
        url: pickFlag(rest, "--url"),
      });
      return;
    case "status":
      await status();
      return;
    case "logout":
      await logout();
      return;
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      console.error(`unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

function pickFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

function printHelp(): void {
  console.log(`opencara — agent host CLI

Usage:
  opencara [--url URL] [--force]   Pair (if needed) and start accepting jobs.
  opencara status                  Show pairing state.
  opencara logout                  Forget the saved pairing.

Options:
  --url URL    Orchestrator URL (default: https://opencara.com,
               or $OPENCARA_URL).
  --force      Re-pair even if already paired.
`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
