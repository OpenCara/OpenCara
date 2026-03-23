import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*'],
    coverage: {
      exclude: [
        // Compiled output — not source code
        '**/dist/**',
        // Type declaration files
        '**/*.d.ts',
        // Type-only files — no runtime code to test
        'packages/server/src/types.ts',
        'packages/server/src/store/interface.ts',
        // Config files — not application code
        'eslint.config.js',
        '**/tsup.config.*',
        '**/vitest.config.*',
        // Test files and helpers
        '**/__tests__/**',
        // CLI entry point — Commander.js invocation, tested via e2e
        'packages/cli/src/index.ts',
        // Server Node.js entry point — startup orchestration, tested via integration
        'packages/server/src/node.ts',
      ],
    },
  },
});
