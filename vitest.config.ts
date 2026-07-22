import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real workerd/Miniflare suites spawn subprocesses. Keep the complete gate
    // reproducible on Windows and smaller CI runners instead of exhausting the
    // process table through Vitest's host-sized default pool.
    maxWorkers: 4,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/d1-types.ts', 'src/index.ts'],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
