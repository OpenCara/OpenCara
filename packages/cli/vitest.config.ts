import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { parse as parseToml } from 'smol-toml';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse tools/*.toml into ToolDef[] (same logic as tsup.config.ts)
const toolsDir = resolve(__dirname, 'tools');
const toolDefs = readdirSync(toolsDir)
  .filter((f) => f.endsWith('.toml'))
  .map((f) => {
    const raw = readFileSync(resolve(toolsDir, f), 'utf-8');
    const data = parseToml(raw) as Record<string, unknown>;
    return {
      name: basename(f, '.toml'),
      binary: data.binary as string,
      models: data.models as string[],
      command: data.command as string,
      scannable: data.scannable as boolean,
      installLink: (data.install_link as string) ?? undefined,
    };
  });

export default defineConfig({
  define: {
    __CLI_VERSION__: JSON.stringify('0.0.0-test'),
    __GIT_COMMIT__: JSON.stringify('test123'),
    __TOOL_DEFS__: JSON.stringify(JSON.stringify(toolDefs)),
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@opencara/shared': resolve(__dirname, '../shared/src/index.ts'),
      '@opencara/server': resolve(__dirname, '../server/src/index.ts'),
    },
  },
});
