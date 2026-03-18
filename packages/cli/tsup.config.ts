import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

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
  },
});
