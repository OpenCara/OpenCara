import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  define: {
    __CLI_VERSION__: JSON.stringify('0.0.0-test'),
    __GIT_COMMIT__: JSON.stringify('test123'),
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
