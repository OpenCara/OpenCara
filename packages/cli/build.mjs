// Bundle the CLI into a single dist/bin.js so the published `opencara`
// package doesn't depend on the unpublished `@opencara/shared` workspace
// package. esbuild inlines the workspace import; runtime deps `ws` and
// `zod` stay external (declared in package.json `dependencies`) so users
// install them once via `npm i -g opencara`.
import { build } from "esbuild";
import { mkdir, rm, chmod } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

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
  legalComments: "none",
  minify: false,
  sourcemap: false,
});

// Make the binary executable so `opencara …` runs straight from npm install
// without needing `node ./node_modules/.bin/opencara`.
await chmod("dist/bin.js", 0o755);
