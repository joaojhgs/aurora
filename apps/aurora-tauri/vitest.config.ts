import { defineConfig } from 'vitest/config'

import { coverageConfig } from '../../vitest.coverage.mjs'

export default defineConfig({
  test: {
    setupFiles: ['./src/test/setup-web-storage.ts'],
    testTimeout: 10_000,
    hookTimeout: 20_000,
    slowTestThreshold: 1_000,
    retry: 0,
    coverage: coverageConfig({
      // The shell keeps its test harness beside the source it exercises.
      exclude: ['src/test/**', 'src/desktop-live-e2e.ts'],
    }),
  },
})
