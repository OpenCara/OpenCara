#!/usr/bin/env node
import { run } from "./commands/run.js";
import { status } from "./commands/status.js";
import { logout } from "./commands/logout.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  switch (cmd) {
    case undefined:
      // bare `opencara` → default flow
      break;
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
      // Anything starting with `-` is a flag for the default flow; bare
      // words are unrecognised subcommands and should error rather than
      // silently turn into a no-op.
      if (!cmd.startsWith("-")) {
        console.error(`unknown command: ${cmd}`);
        printHelp();
        process.exit(1);
      }
  }
  // Default: `opencara [--url URL] [--force-pair]`.
  await run({
    forcePair: argv.includes("--force-pair"),
    url: pickFlag(argv, "--url"),
  });
}

function pickFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

function printHelp(): void {
  console.log(`opencara — agent host CLI

Usage:
  opencara [--url URL] [--force-pair]   Pair (if needed) and start accepting jobs.
  opencara status                       Show pairing state.
  opencara logout                       Forget the saved pairing.

Options:
  --url URL      Orchestrator URL (default: https://opencara.com,
                 or $OPENCARA_URL).
  --force-pair   Re-pair even if already paired.
`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
