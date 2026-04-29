// Bundle the CLI into a single dist/bin.js so the published `opencara`
// package doesn't depend on the unpublished `@opencara/shared` workspace
// package. esbuild inlines the workspace import; runtime deps `ws` and
// `zod` stay external (declared in package.json `dependencies`) so users
// install them once via `npm i -g opencara`.
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

// src/bin.ts already starts with `#!/usr/bin/env node`; esbuild preserves
// the source shebang in bundled output, so don't add a banner (would
// duplicate the shebang and break `node` parsing on some shells).
await build({
  entryPoints: ["src/bin.ts"],
  outfile: "dist/bin.js",
  platform: "node",
  target: "node22",
  format: "esm",
  bundle: true,
  external: ["ws", "zod"],
  define: {
    "process.env.OPENCARA_VERSION": JSON.stringify(pkgVersion),
  },
  legalComments: "none",
  minify: false,
  sourcemap: false,
});

// Make the binary executable so `opencara …` runs straight from npm install
// without needing `node ./node_modules/.bin/opencara`.
await chmod("dist/bin.js", 0o755);
