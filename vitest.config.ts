import { defineConfig } from 'vitest/config';

// The Vite config roots itself at client/ for the app build; the money rules
// live in shared/, so the tests get their own root.
export default defineConfig({
  test: { root: '.', include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'client/**/*.test.ts'] },
});
