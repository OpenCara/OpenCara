// Bundle the CLI binaries into self-contained files so the published
// `opencara` package doesn't depend on the unpublished `@opencara/shared`
// workspace package. esbuild inlines the workspace import; runtime deps
// (`ws`, `zod`, `@modelcontextprotocol/sdk`, `@zed-industries/codex-acp`)
// stay external — declared in package.json `dependencies` so users
// install them once via `npm i -g opencara`.
//
// Two entrypoints:
//   - src/bin.ts         → dist/bin.js        (the `opencara` CLI itself)
//   - src/bin/opencara-mcp.ts → dist/opencara-mcp.js (the stdio MCP
//     server that the agent's ACP `mcpServers` config spawns; without
//     this in the published bundle, ACP-mode chat runs would fail at
//     runtime trying to find a non-existent dev path).
import { build } from "esbuild";
import { mkdir, rm, chmod } from "node:fs/promises";
import { readFileSync } from "node:fs";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

// Read version at build time; esbuild's `define` substitutes the literal
// string into the bundle. Avoids a runtime FS lookup for package.json
// (which broke after we collapsed dist/* into a single dist/bin.js — the
// old `__dirname/../../package.json` was correct for multi-file tsc out,
// wrong for the bundle, and silently fell back to "0.0.0" for every
// connected device on the dashboard).
const pkgVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

// Shared esbuild config. Each entrypoint adds its own outfile.
const common = {
  platform: "node",
  target: "node22",
  format: "esm",
  bundle: true,
  // Keep these as external requires rather than inline. They're either
  // platform-native (codex-acp), large (mcp sdk), or already shared
  // peer-style (ws, zod). package.json `dependencies` ensures install
  // pulls them.
  external: [
    "ws",
    "zod",
    "@modelcontextprotocol/sdk",
    "@modelcontextprotocol/sdk/*",
    "@zed-industries/codex-acp",
  ],
  define: {
    "process.env.OPENCARA_VERSION": JSON.stringify(pkgVersion),
  },
  legalComments: "none",
  minify: false,
  sourcemap: false,
};

// src/bin.ts already starts with `#!/usr/bin/env node`; esbuild preserves
// the source shebang in bundled output, so don't add a banner (would
// duplicate the shebang and break `node` parsing on some shells).
await build({
  ...common,
  entryPoints: ["src/bin.ts"],
  outfile: "dist/bin.js",
});

await build({
  ...common,
  entryPoints: ["src/bin/opencara-mcp.ts"],
  outfile: "dist/opencara-mcp.js",
});

await build({
  ...common,
  entryPoints: ["src/bin/claude-acp.ts"],
  outfile: "dist/claude-acp.js",
});

// Make the binaries executable so `opencara …`, `opencara-mcp`, and
// `claude-acp` run straight from npm install without needing
// `node ./node_modules/.bin/<binary>`.
await chmod("dist/bin.js", 0o755);
await chmod("dist/opencara-mcp.js", 0o755);
await chmod("dist/claude-acp.js", 0o755);
