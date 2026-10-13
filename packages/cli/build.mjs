// Bundle the CLI into one self-contained file so the published `opencara`
// package doesn't depend on the unpublished `@opencara/shared` workspace
// package: esbuild inlines the workspace import. Runtime dependencies stay
// external, declared in package.json `dependencies` so `npm i -g opencara`
// installs them: `ws`, `zod`, and the pi packages agent turns run on —
// pi-durable and friends ship WebAssembly and native-module loaders that
// resolve files relative to their own install, so they can't be inlined.
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
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

// src/bin.ts already starts with `#!/usr/bin/env node`; esbuild preserves
// the source shebang in bundled output, so don't add a banner (would
// duplicate the shebang and break `node` parsing on some shells).
//
// Splitting keeps the agent runner (lazily imported by the daemon) in its
// own chunk, so its external pi imports load only when the daemon starts,
// not for every short-lived `opencara internal …` / `status` process.
await build({
  entryPoints: { bin: "src/bin.ts" },
  outdir: "dist",
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  platform: "node",
  target: "node22",
  format: "esm",
  bundle: true,
  external: Object.keys(pkg.dependencies).flatMap((name) => [name, `${name}/*`]),
  define: {
    "process.env.OPENCARA_VERSION": JSON.stringify(pkg.version),
  },
  legalComments: "none",
  minify: false,
  sourcemap: false,
});

// Executable so `opencara` runs straight from an npm install.
await chmod("dist/bin.js", 0o755);
