import { defineConfig } from 'vitest/config';

// The Vite config roots itself at client/ for the app build; the money rules
// live in shared/, so the tests get their own root. Real PostgreSQL/security
// integration cases intentionally perform password hashing, restarts and DB
// round-trips, so give CI enough headroom without weakening any assertions.
export default defineConfig({
  test: {
    root: '.',
    include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'client/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
