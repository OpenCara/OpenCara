import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { defineConfig } from 'tsup';
import { parse as parseToml } from 'smol-toml';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

let gitCommit = 'unknown';
try {
  gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
} catch {
  // Not a git repo or git not installed — use fallback
}

// Parse tools/*.toml into ToolDef[] at build time
const toolsDir = resolve(import.meta.dirname, 'tools');
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
  entry: ['src/index.ts'],
  format: 'esm',
  target: 'node20',
  platform: 'node',
  splitting: false,
  clean: true,
  noExternal: ['@opencara/shared'],
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
    __GIT_COMMIT__: JSON.stringify(gitCommit),
    __TOOL_DEFS__: JSON.stringify(JSON.stringify(toolDefs)),
  },
});
