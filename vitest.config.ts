import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // exclude REPLACES vitest's defaults, so re-include the standard defaults.
    // test/e2e-inhost is a separate @vscode/test-electron/Mocha runner, NOT vitest
    // (it requires a built fork binary and runs inside the extension host).
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'test/e2e-inhost/**',
    ],
    globals: true,
  },
});
