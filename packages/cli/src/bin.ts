#!/usr/bin/env node
import { register } from "./commands/register.js";
import { run } from "./commands/run.js";
import { status } from "./commands/status.js";
import { logout } from "./commands/logout.js";

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "register":
      await register({
        force: rest.includes("--force"),
        url: pickFlag(rest, "--url"),
      });
      return;
    case "run":
      await run();
      return;
    case "status":
      await status();
      return;
    case "logout":
      await logout();
      return;
    case "--help":
    case "-h":
    case undefined:
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
  opencara register [--url URL] [--force]
  opencara run
  opencara status
  opencara logout
`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
