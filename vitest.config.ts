import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}'],
    // `pnpm coverage` only: a summary in the terminal and an HTML report in coverage/. It measures,
    // it never fails the run: no thresholds. The instrumented run is slower, so the script gives
    // each test 30 s instead of 5 s; the summary is printed even when a test fails.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}'],
      reporter: ['text-summary', 'html'],
      reportOnFailure: true,
    },
  },
});
