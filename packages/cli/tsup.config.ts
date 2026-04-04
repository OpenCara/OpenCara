import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

let gitCommit = 'unknown';
try {
  gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
} catch {
  // Not a git repo or git not installed — use fallback
}

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
  },
});
