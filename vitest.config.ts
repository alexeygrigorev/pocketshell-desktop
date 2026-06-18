import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Unit + integration tests share one vitest config. Integration tests use
// testcontainers and auto-skip when Docker is unavailable (see
// tests/integration/helpers.ts). The "test:unit" and "test:integration"
// npm scripts select a subset via --dir.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000, // testcontainers builds can be slow on first run
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/main/**/*.ts'],
      exclude: ['**/*.d.ts', 'tests/**'],
    },
  },
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
    },
  },
});
