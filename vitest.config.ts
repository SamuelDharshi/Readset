import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run against @readset/core's SOURCE, so editing core needs no rebuild. The published
// package entry points at dist/ because bundlers cannot follow its NodeNext ".js" suffixes.
const coreSrc = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: { alias: { '@readset/core': coreSrc } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'packages/web/**'],
    testTimeout: 180_000, hookTimeout: 180_000,
  },
});
